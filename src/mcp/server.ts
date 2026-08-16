// Main MCP Server Implementation
// Handles the Model Context Protocol server setup and integration with Autotask
// Supports both local (env-based) and gateway (header-based) credential modes

import { createServer, IncomingMessage, ServerResponse, Server as HttpServer } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { AutotaskService } from '../services/autotask.service.js';
import { Logger } from '../utils/logger.js';
import { McpServerConfig } from '../types/mcp.js';
import { EnvironmentConfig, parseCredentialsFromHeaders, GatewayCredentials } from '../utils/config.js';
import { AutotaskResourceHandler } from '../handlers/resource.handler.js';
import { AutotaskToolHandler } from '../handlers/tool.handler.js';
import { RECEPTIONIST_TOOL_NAMES } from '../handlers/tool.definitions.js';
import { matchSpokenName, PoolContact, soleCandidateLock, RepeatedLockAttempts, REPEAT_CANDIDATES_GUIDANCE, REPEAT_NEW_CONTACT_GUIDANCE, isNearMissSurname, isPlaceholderSpokenName } from '../utils/name-match.js';
import { matchSpokenCompany, CompanyCandidate } from '../utils/company-match.js';
import { PicklistCache } from '../services/picklist.cache.js';

// ─── Tenant constants shared by /phone-lookup and /call-closure ───────────────
// Autotask queues whose tickets are machine-generated and never something a caller
// rings about: 8 = monitoring (CheckCentral, Backup Monitor, BackupIQ, Datto AV/EDR).
// Verified 2026-07-26 against 87 live open tickets: queueID 8 caught all 11
// machine-generated ones with no false positives. Add ids here if more appear.
// NOT listed: Merged Tickets — those are set Complete on merge, so a status!==5
// filter already removes them.
// Tenant-specific ids. Mirror any change in ITGlue alongside the queue list.
//
// Module scope on purpose: BOTH the open-ticket preload and the call-closure
// silent-caller bind must exclude the same queues, or a caller who says nothing gets
// their call filed against a backup alert.
export const EXCLUDED_QUEUE_IDS = new Set<number>([8]);


// ─── Names the caller did not give ───────────────────────────────────────────
// Measured 2026-08-06 across 314 lock_contact calls carrying a spoken name since
// 07-23: 7 passed a name that appears nowhere in what the caller said and
// nowhere in caller_context. Three of those were the literal "John Smith"
// (08-03 11:19, 08-04 13:38, 08-06 10:18) on calls where the caller had said
// only "a call about the printer issue" or similar. Three were "Bruce Rideout",
// which came from a worked example in a tool description and stopped once that
// was removed on 08-05 10:54. One was "Unknown Unknown".
//
// Placeholder-name detection lives in utils/name-match.ts (moved 2026-08-15 so the
// create-side guards share it without an import cycle). Re-exported here so
// existing imports and tests keep checking the real function.
export { isPlaceholderSpokenName, NON_NAME_TOKENS, PLACEHOLDER_PAIRS } from '../utils/name-match.js';

// The single answer for "you do not have a name". Deliberately identical whether
// she called with a placeholder or called honestly with just the phone, because
// from her side it is the same position and one state is easier to act on than
// two. Says nothing that can be read back to a caller as a lookup result, and
// says outright that this is a normal place to be -- the KB previously offered
// no state for it, which is what cornered her into inventing one.
// Distance-aware new_contact guidance (2026-08-15, Brian). Re-saying a name
// mostly reproduces the same transcription, so the escalation differs by what
// the distance to the records says. Near-miss: spelling is the one channel
// that adds signal. Nothing close: no re-ask at all; the capture flow already
// spell-confirms once before writing.
export const NEAR_MISS_GUIDANCE =
  'The name lands close to the records without matching. Ask the caller to ' +
  'spell their last name, then call again with the spelled name. The names on ' +
  'file stay internal.';

export const CLEAR_NEW_GUIDANCE =
  'No one near that name at this account: treat the caller as new. Offer ' +
  'Identity Capture per the SOP now; the capture flow confirms spelling ' +
  'before anything is written.';

export const NO_NAME_GUIDANCE = 'No name yet, and that is fine \u2014 nothing was looked up, so there is nothing to tell the caller. Ask who you are speaking with, then call again with their answer. Never use a name the caller did not say.';


export class AutotaskMcpServer {
  private server: Server;
  private config: McpServerConfig;
  private autotaskService: AutotaskService;
  private resourceHandler: AutotaskResourceHandler;
  private toolHandler: AutotaskToolHandler;
  private logger: Logger;
  private envConfig: EnvironmentConfig | undefined;
  private httpServer?: HttpServer;
  private picklistCache: PicklistCache;
  private repeatedLocks = new RepeatedLockAttempts();
  private ticketPicklistIds: { statusNew: number; priorityNormal: number } | null = null;

  constructor(config: McpServerConfig, logger: Logger, envConfig?: EnvironmentConfig) {
    this.logger = logger;
    this.config = config;
    this.envConfig = envConfig;

    // Initialize Autotask service
    this.autotaskService = new AutotaskService(config, logger);

    // Initialize handlers
    this.resourceHandler = new AutotaskResourceHandler(this.autotaskService, logger);
    this.toolHandler = new AutotaskToolHandler(this.autotaskService, logger);

    // Picklist cache for resolving ticket status/priority IDs
    this.picklistCache = new PicklistCache(
      logger,
      (entityType) => this.autotaskService.getFieldInfo(entityType)
    );

    // Create default server (used for stdio mode)
    this.server = this.createFreshServer();
  }

  /**
   * Create a fresh MCP Server with all handlers registered.
   * Called per-request in HTTP (stateless) mode so each initialize gets a clean server.
   */
  private createFreshServer(toolProfile?: string): Server {
    const server = new Server(
      {
        name: this.config.name,
        version: this.config.version,
      },
      {
        capabilities: {
          resources: {
            subscribe: false,
            listChanged: true
          },
          tools: {
            listChanged: true
          }
        },
        instructions: this.getServerInstructions()
      }
    );

    server.onerror = (error) => {
      this.logger.error('MCP Server error:', error);
    };

    server.oninitialized = () => {
      this.logger.info('MCP Server initialized and ready to serve requests');
    };

    this.setupHandlers(server, toolProfile);
    this.toolHandler.setServer(server);

    return server;
  }

  /**
   * Set up all MCP request handlers
   */
  private setupHandlers(server: Server, toolProfile?: string): void {
    this.logger.info('Setting up MCP request handlers...');

    // List available resources
    server.setRequestHandler(ListResourcesRequestSchema, async () => {
      try {
        this.logger.debug('Handling list resources request');
        const resources = await this.resourceHandler.listResources();
        return { resources };
      } catch (error) {
        this.logger.error('Failed to list resources:', error);
        throw new McpError(
          ErrorCode.InternalError,
          `Failed to list resources: ${error instanceof Error ? error.message : 'Unknown error'}`
        );
      }
    });

    // Read a specific resource
    server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      try {
        this.logger.debug(`Handling read resource request for: ${request.params.uri}`);
        const content = await this.resourceHandler.readResource(request.params.uri);
        return { contents: [content] };
      } catch (error) {
        this.logger.error(`Failed to read resource ${request.params.uri}:`, error);
        throw new McpError(
          ErrorCode.InternalError,
          `Failed to read resource: ${error instanceof Error ? error.message : 'Unknown error'}`
        );
      }
    });

    // List available tools
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      try {
        this.logger.debug('Handling list tools request', { toolProfile });
        let tools = await this.toolHandler.listTools();
        if (toolProfile === 'receptionist') {
          tools = tools.filter(t => RECEPTIONIST_TOOL_NAMES.has(t.name));
        }
        return { tools };
      } catch (error) {
        this.logger.error('Failed to list tools:', error);
        throw new McpError(
          ErrorCode.InternalError,
          `Failed to list tools: ${error instanceof Error ? error.message : 'Unknown error'}`
        );
      }
    });

    // Call a tool
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        this.logger.debug(`Handling tool call: ${request.params.name}`);
        if (toolProfile === 'receptionist' && !RECEPTIONIST_TOOL_NAMES.has(request.params.name)) {
          throw new McpError(
            ErrorCode.MethodNotFound,
            `Tool ${request.params.name} is not available in the receptionist profile`
          );
        }
        const result = await this.toolHandler.callTool(
          request.params.name,
          request.params.arguments || {}
        );
        // Spread object-shaped data at the envelope level so ElevenLabs can
        // resolve value_path against top-level fields (e.g. contact.id).
        // ElevenLabs resolves value_path against this outer envelope, not
        // against the JSON string inside content[0].text.
        const response: any = {
          content: result.content,
          isError: result.isError,
        };
        if (result.data && typeof result.data === 'object' && !Array.isArray(result.data)) {
          Object.assign(response, result.data);
        }
        return response;
      } catch (error) {
        this.logger.error(`Failed to call tool ${request.params.name}:`, error);
        throw new McpError(
          ErrorCode.InternalError,
          `Failed to call tool: ${error instanceof Error ? error.message : 'Unknown error'}`
        );
      }
    });

    this.logger.info('MCP request handlers set up successfully');
  }

  /**
   * Start the MCP server with the configured transport
   */
  async start(): Promise<void> {
    const transportType = this.envConfig?.transport?.type || 'stdio';
    this.logger.info(`Starting Autotask MCP Server with ${transportType} transport...`);

    if (transportType === 'http') {
      await this.startHttpTransport();
    } else {
      await this.startStdioTransport();
    }
  }

  /**
   * Start with stdio transport (default)
   */
  private async startStdioTransport(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    this.logger.info('Autotask MCP Server started and connected to stdio transport');
  }

  /**
   * Start with HTTP Streamable transport
   * In gateway mode, credentials are extracted from request headers on each request
   */
  private async startHttpTransport(): Promise<void> {
    const port = this.envConfig?.transport?.port || 8080;
    const host = this.envConfig?.transport?.host || '0.0.0.0';
    const isGatewayMode = this.envConfig?.auth?.mode === 'gateway';

    this.httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

      // Health endpoint - no auth required
      if (url.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'ok',
          transport: 'http',
          authMode: isGatewayMode ? 'gateway' : 'env',
          timestamp: new Date().toISOString()
        }));
        return;
      }

      // Version endpoint - reports the git commit Railway is currently serving.
      // Railway injects RAILWAY_GIT_COMMIT_SHA automatically. No auth required.
      if (url.pathname === '/version') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          commit: process.env.RAILWAY_GIT_COMMIT_SHA || 'unknown',
          branch: process.env.RAILWAY_GIT_BRANCH || 'unknown',
          deployedAt: process.env.RAILWAY_DEPLOYMENT_CREATED_AT || 'unknown'
        }));
        return;
      }

      // Bearer token auth — required for all endpoints except /health and /call-closure
      const sharedSecret = process.env.RAILWAY_SHARED_SECRET;
      if (sharedSecret && url.pathname !== '/call-closure') {
        const authHeader = (req.headers['authorization'] || '').toString();
        const token = authHeader.replace(/^Bearer\s+/i, '');
        if (token !== sharedSecret) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }
      }

      // MCP endpoint — stateless: fresh server + transport per request
      if (url.pathname === '/mcp') {
        // Only POST is supported in stateless mode
        if (req.method !== 'POST') {
          res.writeHead(405, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32000, message: 'Method not allowed' },
            id: null,
          }));
          return;
        }

        // In gateway mode, extract credentials from headers
        if (isGatewayMode) {
          const credentials = this.extractGatewayCredentials(req);
          if (!credentials.username || !credentials.secret || !credentials.integrationCode) {
            this.logger.warn('Gateway mode: Missing required credentials in headers', {
              hasUsername: !!credentials.username,
              hasSecret: !!credentials.secret,
              hasIntegrationCode: !!credentials.integrationCode,
            });
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              error: 'Missing credentials',
              message: 'Gateway mode requires X-API-Key, X-API-Secret, and X-Integration-Code headers',
              required: ['X-API-Key', 'X-API-Secret', 'X-Integration-Code']
            }));
            return;
          }
          // Update service credentials for this request
          this.updateCredentials(credentials);
        }

        // Stateless: create fresh server + transport for each request.
        // X-Tool-Profile header scopes the visible toolset (e.g. receptionist).
        const toolProfile = String(req.headers['x-tool-profile'] || '').toLowerCase() || undefined;
        const server = this.createFreshServer(toolProfile);
        const transport = new StreamableHTTPServerTransport({
          enableJsonResponse: true,
        });

        res.on('close', () => {
          transport.close();
          server.close();
        });

        server.connect(transport as unknown as Transport).then(() => {
          transport.handleRequest(req, res);
        }).catch((err) => {
          this.logger.error('MCP transport error:', err);
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              jsonrpc: '2.0',
              error: { code: -32603, message: 'Internal error' },
              id: null,
            }));
          }
        });

        return;
      }

      // Contact lock endpoint — flat JSON so ElevenLabs value_path resolves confirmed_* variables.
      // MCP tool responses cannot carry extra fields past the SDK's Zod schema; this endpoint
      // returns raw HTTP JSON that ElevenLabs webhook/server tools resolve directly.
      if (url.pathname === '/contact-lock') {
        if (req.method !== 'POST') {
          res.writeHead(405, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Method not allowed' }));
          return;
        }

        if (isGatewayMode) {
          const credentials = this.extractGatewayCredentials(req);
          if (!credentials.username || !credentials.secret || !credentials.integrationCode) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing credentials' }));
            return;
          }
          this.updateCredentials(credentials);
        }

        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', async () => {
          try {
            const parsed = JSON.parse(body || '{}');

            // Phase A (2026-06-11): spoken-name lock. When spoken names are
            // provided (and no contact_id), derive the candidate pool from the
            // caller's phone and match server-side. Fail-soft: any lookup
            // error returns no_verdict and the agent proceeds with the
            // standard search flow. The contact_id path below is unchanged.
            const spokenFirst = String(parsed.spoken_first || '').trim();
            const spokenLast = String(parsed.spoken_last || '').trim();
            const spokenCompany = String(parsed.spoken_company || '').trim();
            const callerPhone = String(parsed.caller_phone || '').trim();
            const lockAttemptKey = RepeatedLockAttempts.key(callerPhone, parsed.company_id, spokenFirst, spokenLast);
            const priorIdenticalAttempts = (spokenFirst || spokenLast) ? this.repeatedLocks.countAndRecord(lockAttemptKey) : 0;
            // Refuse a placeholder before spending a lookup on it. Returns its own
            // status so the agent cannot read this as "no such person, offer to add
            // them" -- which is exactly what happened on 08-06 10:18, where she
            // followed a fabricated "John Smith" straight into offering to create a
            // contact at a company whose phone had already matched.
            // A canonical placeholder pair is refused ONLY when nobody by that name
            // exists at the phone-matched company. Real Jane Smiths exist (Brian tested
            // as one on 2026-08-15 and hit the refusal); an INVENTED Jane Smith matches
            // nobody, so the pool check preserves the anti-fabrication guard while a
            // real, on-file Jane Smith locks like anyone else.
            let placeholderVouchedByPool = false;
            if (!parsed.contact_id && isPlaceholderSpokenName(spokenFirst, spokenLast) && callerPhone) {
              try {
                const pc = await this.autotaskService.searchContacts({ phone: callerPhone }) as PoolContact[];
                const cid0 = [...new Set((pc || []).map(c => c.companyID).filter((x): x is number => x != null))];
                if (cid0.length === 1) {
                  const pool0 = await this.autotaskService.searchContacts({ companyID: cid0[0], pageSize: 200 } as any) as PoolContact[];
                  const v0 = matchSpokenName(pool0 || [], spokenFirst, spokenLast);
                  placeholderVouchedByPool = v0.status === 'locked' || (v0.status === 'candidates' && v0.count >= 1);
                }
              } catch { /* fail toward the refusal, the safe side */ }
            }
            if (!parsed.contact_id && isPlaceholderSpokenName(spokenFirst, spokenLast) && !placeholderVouchedByPool) {
              this.logger.warn('Contact lock: placeholder name refused', { spokenFirst, spokenLast });
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({
                status: 'no_name_yet',
                // Wording matters as much as the refusal. Brian, 2026-08-06:
                // on the 10:18 call she did not just invent "John Smith", she
                // said it out loud -- "I don't have a John Smith on file at Daus
                // Technologies."
                //
                // She narrates negative identity lookups constantly: 95 agent
                // turns across 76 calls since 07-23. Nearly all of it is good
                // service ("I don't see you listed as a contact yet, shall I add
                // you?" to someone who just gave their name), so the narration is
                // not the defect and suppressing it would break the good case.
                //
                // The defect is an invented name acquiring a lookup result to
                // narrate. So this response gives her nothing shaped like one: it
                // does not echo the submitted name, does not say "not found", and
                // does not use the word placeholder, because any of those can be
                // read back to the caller as a finding. It states a fact about the
                // call and the next action, and says outright that there is
                // nothing to report -- which is more robust than forbidding it.
                guidance: NO_NAME_GUIDANCE,
              }));
              return;
            }

            // callerPhone alone now enters here. Until 2026-08-06 it did not, so a
            // call carrying only the phone fell through to the contact_id parser and
            // came back HTTP 400. That made the one honest move -- "look me up with
            // what I actually have" -- an error, while every documented exit from
            // IDENTIFYING required a name. See the no_name_yet branch below.
            if (!parsed.contact_id && (spokenFirst || spokenLast || spokenCompany || parsed.company_id || callerPhone)) {
              try {
                // A company already resolved on this call -- a search result, or the
                // prelock -- can enter the identity step directly. Without this the
                // company came from caller_phone and nothing else, and spoken_company
                // only picked among candidates the phone had already produced, so an
                // unknown phone was a dead end regardless of what was already known.
                // 2026-08-03 07:09: one turn after search_companies returned active
                // company 706 "Innovative DisplayWorks Inc. (IDW)", this endpoint
                // answered no_record and company 6866 was created as a duplicate of it.
                // The aim is to make the correct move the available one.
                // A company already resolved on this call -- a search result, or the
                // prelock -- can enter the identity step directly. Two guards below.
                //
                // Why this exists: the company was derived from caller_phone and nothing
                // else. spoken_company only picked among candidates the phone had already
                // produced, so it could never introduce a company the phone had not found.
                // An unknown phone was therefore a dead end no matter what was known.
                //
                // The KB has been asking for this all along. Identity SOP L79, on the
                // no_record branch, says to search the company and "lock it" -- an
                // instruction no tool could carry out. 2026-08-03 07:09: search_companies
                // returned active company 706 "Innovative DisplayWorks Inc. (IDW)", the
                // caller confirmed it, and with nothing that would accept 706 the call
                // ended in company 6866 as a duplicate. This makes L79 executable.
                const rawCompanyId = parsed.company_id;
                const knownCompanyID = parseInt(String(rawCompanyId ?? ''), 10);
                // Guard 1: range. Companies in this tenant are 3-4 digit ids (observed
                // 174..6866); contacts are 8-digit (30,6xx,xxx+). A value that large is a
                // contactID misrouted into this slot, and honouring it would pool contacts
                // for a company that does not exist and report new_contact against it.
                // Mirrors the contact_id range guard below. Falls through rather than
                // erroring, so a bad value degrades to the existing phone behaviour.
                // Guard 2: a spoken name is required. company_id alone would hand
                // matchSpokenName no name at all, whose documented answer for that case is
                // candidates = the whole pool: 151 for company 706. Useless, so skip it.
                const companyIdUsable = Number.isFinite(knownCompanyID)
                  && knownCompanyID > 0
                  && knownCompanyID < 1000000
                  && Boolean(spokenFirst || spokenLast);
                if (rawCompanyId != null && String(rawCompanyId).trim() !== '' && !companyIdUsable) {
                  this.logger.info('Contact lock: company_id supplied but not usable; falling back to phone', {
                    company_id: rawCompanyId, hasSpokenName: Boolean(spokenFirst || spokenLast),
                  });
                }
                if (companyIdUsable) {
                  const pool = await this.autotaskService.searchContacts({ companyID: knownCompanyID, pageSize: 200 } as any) as PoolContact[];
                  const verdict = matchSpokenName(pool || [], spokenFirst, spokenLast);
                  this.logger.info('Contact lock: resolved within a caller-supplied company', {
                    company_id: knownCompanyID, poolSize: (pool || []).length, verdict: verdict.status,
                  });
                  res.writeHead(200, { 'Content-Type': 'application/json' });
                  if (verdict.status === 'locked') {
                    const c = verdict.contact;
                    res.end(JSON.stringify({
                      status: 'locked', match: verdict.match, contact_id: c.id,
                      company_id: c.companyID ?? knownCompanyID,
                      first_name: c.firstName ?? null, last_name: c.lastName ?? null,
                      goes_by: (c as any).middleInitial || null,
                      is_primary: (c as any).primaryContact ?? false,
                    }));
                  } else if (verdict.status === 'candidates') {
                    const soleA = soleCandidateLock(verdict);
                    if (soleA) {
                      this.logger.info('Contact lock: sole exact-first candidate locked at verified company (S5)', {
                        company_id: knownCompanyID, contactId: soleA.id,
                      });
                      res.end(JSON.stringify({
                        status: 'locked', match: 'sole_candidate', contact_id: soleA.id,
                        company_id: soleA.companyID ?? knownCompanyID,
                        first_name: soleA.firstName ?? null, last_name: soleA.lastName ?? null,
                        goes_by: (soleA as any).middleInitial || null,
                        is_primary: (soleA as any).primaryContact ?? false,
                      }));
                    } else if (priorIdenticalAttempts > 0) {
                      res.end(JSON.stringify({ status: 'candidates', count: verdict.count, company_id: knownCompanyID, guidance: REPEAT_CANDIDATES_GUIDANCE }));
                    } else {
                      res.end(JSON.stringify({ status: 'candidates', count: verdict.count, company_id: knownCompanyID }));
                    }
                  } else {
                    if (priorIdenticalAttempts > 0) {
                      res.end(JSON.stringify({ status: 'new_contact', company_id: knownCompanyID, guidance: REPEAT_NEW_CONTACT_GUIDANCE }));
                    } else if (isNearMissSurname(pool || [], spokenLast)) {
                      res.end(JSON.stringify({ status: 'new_contact', company_id: knownCompanyID, guidance: NEAR_MISS_GUIDANCE }));
                    } else {
                      res.end(JSON.stringify({ status: 'new_contact', company_id: knownCompanyID, guidance: CLEAR_NEW_GUIDANCE }));
                    }
                  }
                  return;
                }
                if (!callerPhone) {
                  res.writeHead(200, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify({ status: 'no_verdict', guidance: 'caller_phone missing; proceed with the standard contact search flow.' }));
                  return;
                }
                const phoneContacts = await this.autotaskService.searchContacts({ phone: callerPhone }) as PoolContact[];
                const companyIds = [...new Set((phoneContacts || []).map(c => c.companyID).filter((x): x is number => x != null))];
                if (companyIds.length === 0) {
                  res.writeHead(200, { 'Content-Type': 'application/json' });
                  // Reports what was checked and nothing else. This is a phone lookup:
                  // spoken_company is only consulted in the branch below, when the phone
                  // resolves to two or more companies, so on an unknown phone the caller's
                  // answer to "what company are you calling for?" never reaches the matcher.
                  // The previous text ("Proceed per the Identity SOP no_match flow") told the
                  // consumer what to do, and on 2026-08-03 07:09 that instruction arrived one
                  // turn after search_companies had already returned active company 706
                  // "Innovative DisplayWorks Inc. (IDW)": she created 6866 as a duplicate.
                  // What to do about an unknown phone is the consumer's policy, not this
                  // endpoint's, so it is no longer stated here.
                  res.end(JSON.stringify({ status: 'no_record', checked: 'caller_phone' }));
                  return;
                }
                if (companyIds.length > 1) {
                  // The caller has answered "what company are you calling for?".
                  // Match it here so the candidate names never have to be sent to
                  // the agent -- she cannot read out a list she was never given.
                  // See company-match.ts for the disclosure measurements.
                  if (spokenCompany) {
                    const byCompany = new Map<number, { name: string | null; classification: string | null }>();
                    await Promise.all([...new Set(companyIds)].map(async (cid) => {
                      try {
                        const co = await this.autotaskService.getCompany(cid);
                        if (!co) return;
                        let label: string | null = null;
                        try {
                          const vals = await this.picklistCache.getPicklistValues('Companies', 'classification');
                          label = vals.find(v => String(v.value) === String((co as any).classification))?.label ?? null;
                        } catch { /* classification is optional for matching */ }
                        byCompany.set(cid, { name: co.companyName ?? null, classification: label });
                      } catch { /* a candidate we cannot name simply cannot be matched */ }
                    }));
                    const candidates: CompanyCandidate[] = (phoneContacts || []).map((c: any) => ({
                      contactId: c.id,
                      companyId: c.companyID ?? null,
                      companyName: c.companyID != null ? (byCompany.get(c.companyID)?.name ?? null) : null,
                      classification: c.companyID != null ? (byCompany.get(c.companyID)?.classification ?? null) : null,
                      primaryContact: c.primaryContact ?? false,
                    }));
                    const cv = matchSpokenCompany(candidates, spokenCompany);
                    if (cv.status === 'locked') {
                      const cand = cv.candidate;
                      const full = (phoneContacts || []).find((c: any) => c.id === cand.contactId) as any;
                      this.logger.info('Contact lock: resolved ambiguous company from spoken answer', {
                        spokenCompany, via: cv.via, contactId: cand.contactId, companyId: cand.companyId,
                      });
                      res.writeHead(200, { 'Content-Type': 'application/json' });
                      res.end(JSON.stringify({
                        status: 'locked',
                        match: `company_${cv.via}`,
                        contact_id: cand.contactId,
                        company_id: cand.companyId,
                        first_name: full?.firstName ?? null,
                        last_name: full?.lastName ?? null,
                        goes_by: full?.middleInitial || null,
                        is_primary: full?.primaryContact ?? false,
                      }));
                      return;
                    }
                    if (cv.status === 'ambiguous_residential') {
                      res.writeHead(200, { 'Content-Type': 'application/json' });
                      res.end(JSON.stringify({
                        status: 'ambiguous_residential',
                        count: cv.count,
                        guidance: 'This caller has more than one personal account on file, so "not a company" cannot pick one. Do not list them and do not ask again. Move on: help the caller with what they actually called about, then handle the call as UNVERIFIED INTAKE on companyID 0 and note that their personal accounts need merging. This is a records problem, not the caller\'s problem, and they should not notice it.',
                      }));
                      return;
                    }
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                      status: 'company_no_match',
                      guidance: 'That answer does not match any company on file for this phone. Ask once more for the full company name, or "not a company" if it is personal, and call again with spoken_company. Never name, guess or list a company yourself. If the second attempt also fails, STOP asking about identity: acknowledge it briefly and warmly, carry on with what the caller needs, and handle the call as UNVERIFIED INTAKE on companyID 0. A caller you cannot place still gets answered, transferred, or a message taken. Never leave someone stuck on identity, and never offer to set up a new account for a caller whose company you merely failed to match.',
                    }));
                    return;
                  }
                  // A spoken name CANNOT resolve this branch, and the old guidance
                  // ("proceed per the Identity SOP ambiguous flow") did not say so.
                  // Measured 2026-07-28: on both ambiguous phones seen that day every
                  // candidate company held the SAME person -- Gabe Nakash at 4728 and
                  // 761; Carol McAloney at 437, 1322 and 6225. Name matching across
                  // the pool is therefore useless here by construction, which is why
                  // this returns before matchSpokenName rather than after it.
                  // Only the caller's answer about WHICH company discriminates, and the
                  // only way to act on that answer is a contact_id lock. Say that.
                  res.writeHead(200, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify({
                    status: 'ambiguous_company',
                    company_count: companyIds.length,
                    guidance: 'This phone is on file at more than one company, so no spoken name can resolve it. Ask the caller: "What company are you calling for?" then call this tool AGAIN passing their answer verbatim as spoken_company. The server matches it; you are not given the candidate names and must never guess or offer one. If the caller says it is personal, pass that answer through too. Two attempts maximum, then stop asking, help them anyway, and record it as UNVERIFIED INTAKE on companyID 0.',
                  }));
                  return;
                }
                const companyID = companyIds[0];

                // The phone resolves the account but no name has been given. Answer
                // the question that was actually asked instead of erroring: here is
                // the account, go and get the name. matchSpokenName with no name
                // returns the entire pool as "candidates", which is useless and would
                // read to her as a list she must narrow.
                if (!spokenFirst && !spokenLast) {
                  this.logger.info('Contact lock: phone resolved, no name given yet', { companyID });
                  res.writeHead(200, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify({
                    status: 'no_name_yet',
                    company_id: companyID,
                    guidance: NO_NAME_GUIDANCE,
                  }));
                  return;
                }

                let pool = await this.autotaskService.searchContacts({ companyID, pageSize: 200 } as any) as PoolContact[];
                if (!pool || pool.length === 0) pool = phoneContacts;
                const verdict = matchSpokenName(pool, spokenFirst, spokenLast);
                if (verdict.status === 'locked') {
                  const c = verdict.contact;
                  res.writeHead(200, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify({
                    status: 'locked',
                    match: verdict.match,
                    contact_id: c.id,
                    company_id: c.companyID ?? companyID,
                    first_name: c.firstName ?? null,
                    last_name: c.lastName ?? null,
                    // Nickname the caller may actually go by (CV convention:
                    // Autotask middleInitial). Returned separately so the agent
                    // speaks a clean first name instead of reading a combined
                    // "Cassandra (Sandy)" string aloud.
                    goes_by: (c as any).middleInitial || null,
                    is_primary: (c as any).primaryContact ?? false,
                  }));
                  return;
                }
                if (verdict.status === 'candidates') {
                  const soleB = soleCandidateLock(verdict);
                  res.writeHead(200, { 'Content-Type': 'application/json' });
                  if (soleB) {
                    this.logger.info('Contact lock: sole exact-first candidate locked at phone-verified company (S5)', {
                      companyID, contactId: soleB.id,
                    });
                    res.end(JSON.stringify({
                      status: 'locked', match: 'sole_candidate', contact_id: soleB.id,
                      company_id: soleB.companyID ?? companyID,
                      first_name: soleB.firstName ?? null, last_name: soleB.lastName ?? null,
                      goes_by: (soleB as any).middleInitial || null,
                      is_primary: (soleB as any).primaryContact ?? false,
                    }));
                    return;
                  }
                  if (priorIdenticalAttempts > 0) {
                    res.end(JSON.stringify({ status: 'candidates', count: verdict.count, company_id: companyID, guidance: REPEAT_CANDIDATES_GUIDANCE }));
                    return;
                  }
                  res.end(JSON.stringify({ status: 'candidates', count: verdict.count, company_id: companyID, guidance: 'The name given is not a confident match. Ask the caller to confirm or spell their name, and their last name if you only have a first, then lock again; never list the names on file.' }));
                  return;
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                // The caller is dialling from a number already on file at this
                // company. A name that matches nobody there is more often a
                // mishearing or an invention than a genuinely new person, so
                // confirm the name before offering to add anyone. The old wording
                // ("offer Identity Capture per the SOP") sent her straight to
                // "would you like me to add you as a contact?" on 08-06 10:18.
                res.end(JSON.stringify({ status: 'new_contact', company_id: companyID, guidance:
                  priorIdenticalAttempts > 0 ? REPEAT_NEW_CONTACT_GUIDANCE
                  : isNearMissSurname(pool || [], spokenLast) ? NEAR_MISS_GUIDANCE
                  : CLEAR_NEW_GUIDANCE }));
                return;
              } catch (phaseAErr) {
                this.logger.warn('Spoken-name lock failed; falling back to no_verdict', { err: (phaseAErr as Error)?.message });
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: 'no_verdict', guidance: 'Lookup hiccup; proceed with the standard contact search flow.' }));
                return;
              }
            }

            const contactId = parseInt(String(parsed.contact_id), 10);
            if (!contactId || isNaN(contactId)) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: "contact_id (integer) required. Use the 'id' field from autotask_search_contacts result, not the 'companyID' field." }));
              return;
            }
            // Range guard: contact IDs in this Autotask tenant are 8-digit
            // integers (typically 30,000,000+). Values below 1,000,000 are
            // almost certainly companyIDs being misrouted into the contact slot.
            // Reject explicitly with a helpful error so the model recovers,
            // rather than letting Autotask 500 on a non-existent contact id.
            if (contactId < 1000000) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: `contact_id ${contactId} is too small to be a contact id in this tenant. Contact ids are 8-digit integers (e.g., 30685109). You may have passed a companyID by mistake — use the 'id' field from the autotask_search_contacts result, not 'companyID'.` }));
              return;
            }

            let contact;
            try {
              contact = await this.autotaskService.getContact(contactId);
            } catch (lookupErr) {
              // Autotask SDK throws on 404 for missing contacts. Translate
              // to a clean 404 with a helpful error rather than bubbling up
              // as a generic 500 from the outer catch.
              const lmsg = (lookupErr as Error)?.message || '';
              if (/not.found|404/i.test(lmsg)) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: `Contact ${contactId} not found in Autotask. Verify the id from autotask_search_contacts.` }));
                return;
              }
              throw lookupErr;
            }
            if (!contact) {
              res.writeHead(404, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: `Contact ${contactId} not found in Autotask.` }));
              return;
            }

            // Emit the same verdict shape as the spoken-name path. Without a
            // status field this response matched nothing in the Identity SOP's
            // "LOCK AND ACT ON THE VERDICT" table, so a successful contact_id
            // lock did not look like a lock -- one more reason this path went
            // unused on the ambiguous_company branch it is the only cure for.
            // match: 'id' rather than 'exact'/'fuzzy'; no name matching happened.
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              status: 'locked',
              match: 'id',
              contact_id: contact.id ?? contactId,
              company_id: contact.companyID ?? null,
              first_name: contact.firstName ?? null,
              last_name: contact.lastName ?? null,
              goes_by: (contact as any).middleInitial || null,
              is_primary: contact.primaryContact ?? false,
            }));
          } catch (err) {
            this.logger.error('Contact lock error:', err);
            if (!res.headersSent) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Internal error' }));
            }
          }
        });
        return;
      }

      // Business status endpoint — replaces hardcoded JS in Twilio function.
      // Queries Autotask InternalLocationWithBusinessHours + Holidays in real time.
      // Returns { business_status, holiday_name } for use as ElevenLabs dynamic variables.
      if (url.pathname === '/business-status') {
        if (req.method !== 'POST' && req.method !== 'GET') {
          res.writeHead(405, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Method not allowed' }));
          return;
        }

        if (isGatewayMode) {
          const credentials = this.extractGatewayCredentials(req);
          if (!credentials.username || !credentials.secret || !credentials.integrationCode) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing credentials' }));
            return;
          }
          this.updateCredentials(credentials);
        }

        const respond = async () => {
          try {
            const result = await this.autotaskService.getBusinessStatus();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
          } catch (err) {
            this.logger.error('Business status error:', err);
            if (!res.headersSent) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Internal error' }));
            }
          }
        };

        // Handle both GET and POST (no body needed for either)
        req.on('data', () => {});
        req.on('end', () => { respond(); });
        return;
      }

      // Phone lookup endpoint — enriched caller context for Twilio call-init.
      // Resolves match_type, then fans out to pull company + open tickets so Ivy
      // can make her first move with classification (Gold/Silver/Bronze), open
      // ticket context, and clear signal when the match is ambiguous.
      //
      // match_type values:
      //   exact_contact              — one contact match
      //   multi_contact_one_company  — multiple contacts, same company
      //   ambiguous_multi_company    — multiple contacts spanning companies (NO ticket fetch)
      //   company_main_phone         — no contact, but a company's main phone matches
      //   no_match                   — nothing found anywhere
      //   unknown_caller_id          — blank/private caller_id
      if (url.pathname === '/phone-lookup') {
        if (req.method !== 'POST') {
          res.writeHead(405, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Method not allowed' }));
          return;
        }

        if (isGatewayMode) {
          const credentials = this.extractGatewayCredentials(req);
          if (!credentials.username || !credentials.secret || !credentials.integrationCode) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing credentials' }));
            return;
          }
          this.updateCredentials(credentials);
        }

        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', async () => {
          try {
            const parsed = JSON.parse(body || '{}');
            const phone = String(parsed.phone || '').trim();

            // Case 6: unknown / private caller_id
            if (!phone) {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({
                match_type: 'unknown_caller_id',
                count: 0,
                contacts: [],
                company: null,
                openTickets: [],
                openTicketsTotal: 0,
                ambiguousCandidates: null,
              }));
              return;
            }

            // ── 1. Always start with contact search ──────────────────────────
            const contacts = await this.autotaskService.searchContacts({ phone });

            const contactOut = (c: any) => ({
              id:             c.id,
              firstName:      c.firstName ?? null,
              lastName:       c.lastName  ?? null,
              companyID:      c.companyID ?? null,
              phone:          c.phone     ?? null,
              primaryContact: c.primaryContact ?? false,
            });

            // Resolve classification label for a single Company object.
            // Returns { label: string|null, isManaged: bool } given raw classification integer.
            const resolveClassification = async (classificationId: number | null | undefined) => {
              if (classificationId === null || classificationId === undefined) {
                return { label: null as string | null, isManaged: false };
              }
              try {
                const values = await this.picklistCache.getPicklistValues('Companies', 'classification');
                const match = values.find(v => String(v.value) === String(classificationId));
                const label = match?.label ?? null;
                // Autotask labels include suffix (e.g. "Silver Managed Service"), so match by token.
                const isManaged = label !== null && /\b(Gold|Silver|Bronze)\b/i.test(label);
                return { label, isManaged };
              } catch (e) {
                this.logger.warn('Classification picklist resolution failed', { classificationId, err: (e as Error)?.message });
                return { label: null as string | null, isManaged: false };
              }
            };

            // Resolve CompanyCategory name from a companyCategoryID.
            // Returns null when id is missing or not found. Cached in the service.
            const resolveCategory = async (categoryId: number | null | undefined) => {
              if (categoryId === null || categoryId === undefined) {
                return { id: null as number | null, name: null as string | null };
              }
              try {
                const cat = await this.autotaskService.getCompanyCategory(categoryId);
                return { id: cat?.id ?? Number(categoryId), name: cat?.name ?? null };
              } catch (e) {
                this.logger.warn('CompanyCategory resolution failed', { categoryId, err: (e as Error)?.message });
                return { id: Number(categoryId), name: null };
              }
            };

            // Build enriched company block for a given companyID.
            const buildCompanyBlock = async (companyID: number) => {
              const company = await this.autotaskService.getCompany(companyID);
              if (!company) return null;
              const cls = await resolveClassification((company as any).classification);
              const cat = await resolveCategory((company as any).companyCategoryID);
              return {
                id: company.id ?? companyID,
                name: company.companyName ?? null,
                classification: cls.label,
                isManaged: cls.isManaged,
                categoryId: cat.id,
                category: cat.name,
                web: (company as any).webAddress ?? null,
              };
            };

            // Ceiling on open tickets surfaced to Ivy. Set high on purpose: the point
            // is that the list is COMPLETE for every real company, so Ivy can trust
            // "nothing here fits" and skip the pre-create search. Measured 2026-07-26,
            // caller-facing open tickets: Applied Conveyor 11, RD Rubber 14, Kho &
            // Patel 12, Jacob & Assoc 0; Brian's stated worst case ~30 pre-filter.
            // 20 therefore truncates nobody today. It exists only so caller_context
            // stays bounded if a company ever balloons (migration, onboarding).
            // If it DOES truncate, /phone-lookup reports the true total and the Twilio
            // renderer says "N of M open shown", which tells Ivy to search.
            const MAX_OPEN_TICKETS = 20;

            // Build open-ticket list for a company. Picklist-resolves status label
            // and looks up assignee resource name. Top MAX_OPEN_TICKETS by
            // lastActivityDate desc. Filters out status=5 (Complete) and
            // monitoring-queue tickets client-side.
            //
            // KNOWN LIMITATION (not fixed here): Autotask /query has no server-side
            // sort, so pageSize:50 takes the first 50 by internal ID ascending within
            // the 90-day window, and only then do we sort by lastActivity. A company
            // with >50 tickets active in 90 days can have its newest tickets truncated
            // before the sort sees them. Raising pageSize costs /phone-lookup latency
            // on the pre-speech critical path; tracked separately.
            const buildOpenTickets = async (companyID: number) => {
              try {
                // Autotask's /query endpoint has no server-side sort — records always
                // come back sorted by internal ID asc. To avoid pulling years of history
                // (which made /phone-lookup take 7-9s for established customers), use
                // lastActivityAfter to restrict to the last 90 days, and a small pageSize.
                // A typical managed customer has fewer than 50 tickets active in 90 days.
                const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
                // NO pageSize override. searchTickets defaults to 500 whenever a date
                // filter is present, precisely because Autotask returns ID-ascending and
                // a small page puts the OLDEST tickets on page 1. Passing pageSize:50
                // here reintroduced that bug: at a busy client 84-87% of the 90-day
                // window is Complete, so the first 50 by id yielded only 2-4 surviving
                // open tickets while 12-16 were actually open. Measured 2026-07-26:
                //   Applied Conveyor 102 in 90d / 86 complete / 16 open -> 4 surfaced
                //   Kho & Patel       91 in 90d / 79 complete / 12 open -> 2 surfaced
                //   RD Rubber        110 in 90d / 96 complete / 14 open -> 2 surfaced
                // /phone-lookup measured at 2.3s for the busiest of these against a
                // 7s LOOKUP_BUDGET_MS, so the full page is affordable.
                const tickets = await this.autotaskService.searchTickets({
                  companyId: companyID,
                  lastActivityAfter: ninetyDaysAgo,
                } as any);

                const callerFacing = tickets
                  .filter(t => t.status !== 5)
                  // Machine-generated tickets (RMM/backup/AV monitoring) live in the
                  // monitoring queue. They are internal artifacts, not things a caller
                  // rings about: asking "is this about the overdue check on JA-SRV-DC?"
                  // is confusing and leaks internal monitoring. Excluded from the
                  // caller-facing continuity list entirely — a company whose only open
                  // tickets are alerts correctly reads as "no open work" to Ivy.
                  // Verified 2026-07-26 against 87 preloaded tickets: queueID 8 caught
                  // all 11 machine-generated ones with no false positives.
                  .filter(t => !EXCLUDED_QUEUE_IDS.has((t as any).queueID))
                  .sort((a: any, b: any) => {
                    const da = a.lastActivityDate ? Date.parse(a.lastActivityDate) : 0;
                    const db = b.lastActivityDate ? Date.parse(b.lastActivityDate) : 0;
                    return db - da;
                  });

                // Total caller-facing open tickets, BEFORE the display cap. Ivy uses
                // this to tell a complete list from a truncated one: a complete list
                // that matches nothing lets her skip the pre-create search.
                const totalOpen = callerFacing.length;
                const openTickets = callerFacing.slice(0, MAX_OPEN_TICKETS);

                if (openTickets.length === 0) return { items: [], totalOpen: 0 };

                // Resolve status labels (one picklist lookup, cached)
                let statusMap: Map<string, string> = new Map();
                try {
                  const statusValues = await this.picklistCache.getTicketStatuses();
                  statusMap = new Map(statusValues.map(s => [String(s.value), s.label]));
                } catch (e) {
                  this.logger.warn('Ticket status picklist resolution failed', { err: (e as Error)?.message });
                }

                // Resolve assignee names (parallel, dedup)
                const assigneeIds = Array.from(new Set(
                  openTickets.map((t: any) => t.assignedResourceID).filter((id: any) => id)
                ));
                const assigneeNames: Map<number, string> = new Map();
                await Promise.all(assigneeIds.map(async (id: number) => {
                  try {
                    const r = await this.autotaskService.getResource(id);
                    if (r) {
                      const name = `${r.firstName ?? ''} ${r.lastName ?? ''}`.trim();
                      if (name) assigneeNames.set(id, name);
                    }
                  } catch (e) {
                    this.logger.warn('Resource lookup failed', { id, err: (e as Error)?.message });
                  }
                }));

                return {
                  items: openTickets.map((t: any) => ({
                    id:            t.id ?? null,
                    number:        t.ticketNumber ?? null,
                    title:         t.title ?? null,
                    statusLabel:   statusMap.get(String(t.status)) ?? null,
                    assigneeName:  t.assignedResourceID ? (assigneeNames.get(t.assignedResourceID) ?? null) : null,
                    lastActivity:  t.lastActivityDate ?? null,
                    contactID:     t.contactID ?? null,
                  })),
                  totalOpen,
                };
              } catch (e) {
                this.logger.warn('Open ticket fetch failed', { companyID, err: (e as Error)?.message });
                return { items: [], totalOpen: 0 };
              }
            };

            // ── 2. Branch by contact-search result ───────────────────────────

            // Case 5: no contact match → fall through to company main-phone search
            if (contacts.length === 0) {
              const companies = await this.autotaskService.searchCompanies({ phone });
              if (companies.length === 0) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                  match_type: 'no_match',
                  count: 0,
                  contacts: [],
                  company: null,
                  openTickets: [],
                  openTicketsTotal: 0,
                  ambiguousCandidates: null,
                }));
                return;
              }
              // Case 4: company main phone match. Take the first (most common case).
              const primaryCompany = companies[0];
              const companyID = primaryCompany.id as number;
              const [companyBlock, openTicketsResult] = await Promise.all([
                buildCompanyBlock(companyID),
                buildOpenTickets(companyID),
              ]);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({
                match_type: 'company_main_phone',
                count: 0,
                contacts: [],
                company: companyBlock,
                openTickets: openTicketsResult.items,
                openTicketsTotal: openTicketsResult.totalOpen,
                ambiguousCandidates: null,
              }));
              return;
            }

            const uniqueCompanyIDs = Array.from(new Set(
              contacts.map(c => c.companyID).filter((id): id is number => typeof id === 'number')
            ));

            // Case 3: ambiguous multi-company. Do NOT fetch tickets (risk of cross-company leak).
            // Return safe summary per candidate (name + company name + classification label).
            if (uniqueCompanyIDs.length > 1) {
              const companyBlocks = await Promise.all(
                uniqueCompanyIDs.map(async (cid) => {
                  try {
                    const c = await this.autotaskService.getCompany(cid);
                    if (!c) return null;
                    const cls = await resolveClassification((c as any).classification);
                    return { id: cid, name: c.companyName ?? null, classification: cls.label };
                  } catch {
                    return { id: cid, name: null, classification: null };
                  }
                })
              );
              const companyByID = new Map<number, { name: string | null; classification: string | null }>();
              companyBlocks.forEach(b => { if (b) companyByID.set(b.id, { name: b.name, classification: b.classification }); });

              const ambiguousCandidates = contacts.map((c: any) => {
                const meta = c.companyID != null ? companyByID.get(c.companyID) : undefined;
                return {
                  contactId:      c.id,
                  name:           [c.firstName, c.lastName].filter(Boolean).join(' ') || null,
                  companyId:      c.companyID ?? null,
                  companyName:    meta?.name ?? null,
                  classification: meta?.classification ?? null,
                  primaryContact: c.primaryContact ?? false,
                };
              });

              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({
                match_type: 'ambiguous_multi_company',
                count: contacts.length,
                contacts: contacts.map(contactOut),
                company: null,
                openTickets: [],
                openTicketsTotal: 0,
                ambiguousCandidates,
              }));
              return;
            }

            // Cases 1 & 2: single company (whether one contact or several at same company).
            const companyID = uniqueCompanyIDs[0];
            const [companyBlock, openTicketsResult] = companyID
              ? await Promise.all([buildCompanyBlock(companyID), buildOpenTickets(companyID)])
              : [null, { items: [], totalOpen: 0 }];

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              match_type: contacts.length === 1 ? 'exact_contact' : 'multi_contact_one_company',
              count: contacts.length,
              contacts: contacts.map(contactOut),
              company: companyBlock,
              openTickets: openTicketsResult.items,
              openTicketsTotal: openTicketsResult.totalOpen,
              ambiguousCandidates: null,
            }));
          } catch (err) {
            this.logger.error('Phone lookup error:', err);
            if (!res.headersSent) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Internal error' }));
            }
          }
        });
        return;
      }

      // Resolve extension — converts an extension number to a full SIP URI.
      // Called by Ivy before transferring so the transfer_sip_uri dynamic variable
      // gets set via the webhook tool's response assignment.
      if (url.pathname === '/resolve-extension') {
        if (req.method !== 'POST') {
          res.writeHead(405, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Method not allowed' }));
          return;
        }

        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', async () => {
          try {
            const parsed = JSON.parse(body || '{}');
            const ext = String(parsed.extension || '').trim();
            if (!ext) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'extension required' }));
              return;
            }

            // Strict 4-digit check. bvoip/1stream routes are exactly 4 digits:
            // tech officeExtensions (1001/1004/1005…) and queue extensions from
            // kb_queue_gating Relief Valve (8000/8002/8003/8004). Rejects:
            //   - string hallucinations: "support", "voicemail", "main"
            //   - Autotask queue IDs misused as routes (e.g. 29682833) — those
            //     are ticket-tagging identifiers, not routable in bvoip.
            if (!/^\d{4}$/.test(ext)) {
              this.logger.warn(`resolve-extension: rejected non-4-digit input ${JSON.stringify(ext)}`);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({
                sip_uri: '',
                extension: ext,
                status: 'unknown_extension',
                message: `Extension '${ext}' is not a routable extension. bvoip extensions are exactly 4 digits. Use a tech officeExtension from autotask_search_resources, or a queue extension from kb_queue_gating's Relief Valve (8000 Sales, 8002 Business Support, 8003 Home Support, 8004 Billing). Autotask queue IDs from autotask_list_queues are NOT routable — they are ticket-tagging identifiers only.`,
              }));
              return;
            }

            const sipUri = `sip:${ext}@cvit.bvoip.net`;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ sip_uri: sipUri, extension: ext, status: 'ok' }));
          } catch (err) {
            this.logger.error('Resolve extension error:', err);
            if (!res.headersSent) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Internal error' }));
            }
          }
        });
        return;
      }

      // Call closure webhook — ElevenLabs fires this after every conversation ends.
      // Creates an Autotask ticket documenting the call. Authenticated via HMAC-SHA256
      // signature from ElevenLabs, not bearer token.
      if (url.pathname === '/call-closure') {
        if (req.method !== 'POST') {
          res.writeHead(405, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Method not allowed' }));
          return;
        }

        const webhookSecret = process.env.ELEVENLABS_WEBHOOK_SECRET;
        if (!webhookSecret) {
          this.logger.error('ELEVENLABS_WEBHOOK_SECRET not configured');
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Webhook not configured' }));
          return;
        }

        let rawBody = '';
        let bodySize = 0;
        req.on('data', (chunk) => {
          bodySize += chunk.length;
          if (bodySize > 1_000_000) {
            res.writeHead(413, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Payload too large' }));
            req.destroy();
            return;
          }
          rawBody += chunk;
        });
        req.on('end', async () => {
          try {
            // Verify HMAC-SHA256 signature
            // ElevenLabs format: "t=<unix_timestamp>,v0=<hex_hmac>"
            // HMAC is computed over "<timestamp>.<body>" using the webhook secret
            const sigHeader = (req.headers['elevenlabs-signature'] || '').toString();
            if (!sigHeader) {
              res.writeHead(401, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Missing signature' }));
              return;
            }

            // Parse t= and v0= components from the signature header
            const sigParts: Record<string, string> = {};
            for (const part of sigHeader.split(',')) {
              const [key, ...rest] = part.split('=');
              sigParts[key] = rest.join('=');
            }
            const timestamp = sigParts['t'];
            const receivedSig = sigParts['v0'];

            if (!timestamp || !receivedSig) {
              this.logger.warn('Call closure webhook: malformed signature header', { sigHeader });
              res.writeHead(401, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Malformed signature' }));
              return;
            }

            // Compute expected signature: HMAC-SHA256(secret, "<timestamp>.<body>")
            const signedPayload = `${timestamp}.${rawBody}`;
            const expectedSig = createHmac('sha256', webhookSecret).update(signedPayload).digest('hex');

            const sigBuf = Buffer.from(receivedSig);
            const expectedBuf = Buffer.from(expectedSig);
            if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
              this.logger.warn('Call closure webhook: invalid signature');
              res.writeHead(401, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Invalid signature' }));
              return;
            }

            const rawPayload = JSON.parse(rawBody);
            // Webhook wraps conversation data: { type: "post_call_transcription", data: { ... } }
            const payload = rawPayload.data || rawPayload;
            const dynVars = payload.conversation_initiation_client_data?.dynamic_variables || {};
            const analysis = payload.analysis || {};
            const dataCollection = analysis.data_collection_results || {};
            const metadata = payload.metadata || {};
            const phoneCall = metadata.phone_call || {};

            // -- Minimum data rules --
            const confirmedContactId = dynVars.confirmed_contact_id ? parseInt(String(dynVars.confirmed_contact_id)) : null;
            const confirmedCompanyId = dynVars.confirmed_company_id ? parseInt(String(dynVars.confirmed_company_id)) : null;

            // Lenient identity: prefer confirmed (lock fired), fall back to prelocked.
            // A single contact on a caller-ID is our Autotask data — credit the ticket to them
            // even if Ivy didn't formally lock during the call.
            const prelockedContactId = dynVars.prelocked_contact_id ? parseInt(String(dynVars.prelocked_contact_id)) : null;
            const prelockedCompanyId = dynVars.prelocked_company_id ? parseInt(String(dynVars.prelocked_company_id)) : null;
            const prelockedCompanyName = dynVars.prelocked_company_name || null;
            const prelockedFirstName = dynVars.prelocked_first_name || null;
            const prelockedLastName = dynVars.prelocked_last_name || null;

            const hasPrelockedContact = !!(prelockedContactId && !isNaN(prelockedContactId) && prelockedContactId > 0);
            const hasPrelockedCompany = !!(prelockedCompanyId && !isNaN(prelockedCompanyId) && prelockedCompanyId > 0);

            // Was autotask_lock_contact successfully called during this call?
            // If not, the agent never identified the caller. Mid-call "discovery" from
            // search-result substring matches is unsafe — the caller never confirmed.
            // In that case fall through to the Unidentified path so the ticket lands on
            // AUTOTASK_DEFAULT_COMPANY_ID with the phone number in the title.
            let lockContactFired = false;
            try {
              const transcript: any[] = payload.transcript || [];
              outer: for (const turn of transcript) {
                for (const tr of (turn.tool_results || [])) {
                  const name: string = tr.tool_name || '';
                  if (!name.endsWith('autotask_lock_contact')) continue;
                  if (tr.is_error) continue;
                  const value = tr.result_value;
                  if (typeof value !== 'string') continue;
                  try {
                    const obj = JSON.parse(value);
                    if (typeof obj?.contact_id === 'number' && obj.contact_id > 0) {
                      lockContactFired = true;
                      break outer;
                    }
                  } catch { continue; }
                }
              }
            } catch (err) {
              this.logger.warn('Call closure: lock_contact scan failed', { err: (err as Error).message });
            }

            // Mid-call discovery fallback: when /phone-lookup timed out at call start
            // (caller_context fail-safe) AND autotask_lock_contact never fired, the
            // model often identifies the company/contact mid-call via search tools.
            // Scan transcript for the LAST autotask_search_companies and
            // autotask_search_contacts result that returned exactly one item, and
            // use those as a last fallback before defaulting to AUTOTASK_DEFAULT_COMPANY_ID.
            // Promotion to effective* is gated on lockContactFired below — discovery
            // from a search hit the caller never confirmed is not safe identity.
            let discoveredContactId: number | null = null;
            let discoveredCompanyId: number | null = null;
            let discoveredFirstName: string | null = null;
            let discoveredLastName: string | null = null;
            let discoveredCompanyName: string | null = null;
            try {
              const transcript: any[] = payload.transcript || [];
              for (const turn of transcript) {
                for (const tr of (turn.tool_results || [])) {
                  const name: string = tr.tool_name || '';
                  const value = tr.result_value;
                  if (typeof value !== 'string') continue;
                  let inner: any = null;
                  try {
                    const mcp = JSON.parse(value);
                    const text = mcp?.content?.[0]?.text;
                    if (typeof text !== 'string') continue;
                    inner = JSON.parse(text);
                  } catch { continue; }
                  if (inner?.summary?.returned !== 1) continue;
                  const item = Array.isArray(inner.items) ? inner.items[0] : null;
                  if (!item) continue;
                  if (name.endsWith('autotask_search_companies')) {
                    if (typeof item.id === 'number') discoveredCompanyId = item.id;
                    if (typeof item.companyName === 'string') discoveredCompanyName = item.companyName;
                  } else if (name.endsWith('autotask_search_contacts')) {
                    if (typeof item.id === 'number') discoveredContactId = item.id;
                    if (typeof item.firstName === 'string') discoveredFirstName = item.firstName;
                    if (typeof item.lastName === 'string') discoveredLastName = item.lastName;
                    if (!discoveredCompanyId && typeof item.companyID === 'number') {
                      discoveredCompanyId = item.companyID;
                    }
                  }
                }
              }
            } catch (err) {
              this.logger.warn('Call closure: transcript scan failed', { err: (err as Error).message });
            }

            const effectiveContactId = (confirmedContactId && !isNaN(confirmedContactId) ? confirmedContactId : null) || (hasPrelockedContact ? prelockedContactId : null) || (lockContactFired ? discoveredContactId : null);
            const effectiveCompanyId = (confirmedCompanyId && !isNaN(confirmedCompanyId) ? confirmedCompanyId : null) || (hasPrelockedCompany ? prelockedCompanyId : null) || (lockContactFired ? discoveredCompanyId : null);
            const effectiveFirstName = dynVars.confirmed_first_name || prelockedFirstName || (lockContactFired ? discoveredFirstName : null) || '';
            const effectiveLastName = dynVars.confirmed_last_name || prelockedLastName || (lockContactFired ? discoveredLastName : null) || '';
            const effectiveCompanyName = prelockedCompanyName || (lockContactFired ? discoveredCompanyName : null);

            const fullyIdentified = !!(effectiveContactId && effectiveCompanyId);
            const companyOnlyIdentified = !fullyIdentified && !!effectiveCompanyId;

            const rawCallReason = dataCollection.call_reason?.value ?? null;
            const hasRealCallReason = rawCallReason && rawCallReason.toLowerCase() !== 'none' && rawCallReason.trim() !== '';

            // Unconditional skip on vendor/sales solicitation, regardless of identification.
            // Ivy flags these by prefixing call_reason with "Solicitation: " per the
            // agent's call_reason data_collection extraction rule.
            const isSolicitation = !!(rawCallReason && rawCallReason.trim().toLowerCase().startsWith('solicitation:'));
            if (isSolicitation) {
              this.logger.info('Call closure: skipped — vendor/sales solicitation', {
                conversationId: payload.conversation_id,
                callReason: rawCallReason,
              });
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ action: 'skipped', reason: 'Vendor/sales solicitation' }));
              return;
            }

            if (!fullyIdentified && !companyOnlyIdentified && !hasRealCallReason) {
              this.logger.info('Call closure: skipped — no identified caller and no call reason', {
                conversationId: payload.conversation_id,
              });
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ action: 'skipped', reason: 'No identified caller and no call reason' }));
              return;
            }

            // -- Build ticket fields --
            const callReason = rawCallReason || 'General Inquiry';
            const callerName = fullyIdentified
              ? [effectiveFirstName, effectiveLastName].filter(Boolean).join(' ') || 'Unknown Caller'
              : null;
            const callerPhone = phoneCall.external_number || dynVars.caller_phone || 'Unknown';
            const durationSecs = metadata.call_duration_secs || null;
            const durationStr = durationSecs != null ? `${Math.ceil(durationSecs / 60)} min (${durationSecs}s)` : 'Unknown';
            const summary = analysis.transcript_summary || 'No summary available.';
            const transferredTo = dataCollection.call_routed_to?.value ?? null;
            const businessStatus = dynVars.business_status || 'Unknown';
            const termination = metadata.termination_reason || 'unknown';
            const callOutcome = analysis.call_successful || 'unknown';

            // Title format follows MSPIntegrations convention:
            //   [User or Company] - [Action Required] - [System or Service]
            // ticket_action and ticket_system are filled by the agent per
            // data_collection schemas. Fall back to a truncated call_reason
            // if either is missing.
            const ticketAction = (dataCollection.ticket_action?.value || '').trim();
            const ticketSystem = (dataCollection.ticket_system?.value || '').trim() || 'General IT Support';
            const truncatedReason = callReason.length > 60
              ? callReason.slice(0, 60).replace(/[ ,.;:!?-]+$/, '') + '...'
              : callReason;
            const subjectClause = ticketAction
              ? `${ticketAction} - ${ticketSystem}`
              : `${truncatedReason} - ${ticketSystem}`;

            let title: string;
            if (fullyIdentified) {
              title = `${callerName} - ${subjectClause}`.substring(0, 255);
            } else if (companyOnlyIdentified) {
              const coLabel = effectiveCompanyName || `Company ${effectiveCompanyId}`;
              title = `[Unverified] ${coLabel} - ${subjectClause}`.substring(0, 255);
            } else {
              title = `[Unverified] ${callerPhone} - ${subjectClause}`.substring(0, 255);
            }

            const callerLine = fullyIdentified
              ? `Caller: ${callerName}`
              : companyOnlyIdentified
                ? `Caller: Unverified contact at ${effectiveCompanyName || `company ${effectiveCompanyId}`}`
                : `Caller: Unidentified (no record on file for ${callerPhone})`;

            const descriptionLines = [
              '== Ivy Call Closure Report ==',
              '',
              `Summary: ${summary}`,
              '',
              `Call Reason: ${callReason}`,
              callerLine,
              `Caller Phone: ${callerPhone}`,
              `Duration: ${durationStr}`,
              `Business Status: ${businessStatus}`,
              transferredTo ? `Transferred To: ${transferredTo}` : null,
              `Call Outcome: ${callOutcome}`,
              `Termination: ${termination}`,
              '',
              `Conversation ID: ${payload.conversation_id}`,
            ];
            const description = descriptionLines.filter(line => line !== null).join('\n');

            // -- Idempotency: check if Ivy already created a ticket mid-call --
            const existingTicketNumber = dataCollection.support_ticket_number?.value ?? null;
            if (existingTicketNumber) {
              try {
                const tickets = await this.autotaskService.searchTickets({ searchTerm: existingTicketNumber });
                if (tickets.length > 0) {
                  const existing = tickets[0];
                  await this.autotaskService.createTicketNote(existing.id!, {
                    title: 'Ivy Call Closure Update',
                    description: description,
                    noteType: 1, // General
                    publish: 2,  // Internal Only (verified against live tenant ticket 53302)
                  });
                  this.logger.info('Call closure: added note to existing ticket', {
                    ticketId: existing.id,
                    ticketNumber: existing.ticketNumber,
                    conversationId: payload.conversation_id,
                  });
                  res.writeHead(200, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify({
                    ticket_id: existing.id,
                    ticket_number: existing.ticketNumber,
                    action: 'updated',
                  }));
                  return;
                }
              } catch (noteErr) {
                this.logger.warn('Call closure: failed to update existing ticket, will create new', {
                  ticketNumber: existingTicketNumber,
                  error: noteErr,
                });
                // Fall through to create a new ticket
              }
            }

            // -- Tool-history binding: which ticket did Ivy actually work on? --
            // The support_ticket_number check above only fires when a ticket NUMBER was
            // SPOKEN, because that value comes from EL's extractor reading the transcript.
            // Ivy is instructed not to recite numbers at callers (KB Gate B, Speaking SOP),
            // so on a call where she noted or updated an existing ticket without saying its
            // number, closure had no idea and created a duplicate. Observed 2026-07-26 on
            // conv_2601kygjncg9etb9fwztqcaq648x: she called update_ticket{ticketId:57465}
            // twice and closure still created T20260726.0012.
            //
            // The webhook payload carries the full tool history, so we can read what she DID
            // instead of inferring from what was said. Precedent: commit 01882bcd already
            // scans payload.transcript for company/contact discovery.
            //
            // Priority, strongest evidence first (agreed with Brian 2026-07-26):
            //   1. created  - a ticket she opened during the call IS this call's ticket
            //   2. noted    - she deliberately recorded this call against it
            //   3. updated  - she acted on it
            // Merely VIEWING a ticket (get_ticket_details) deliberately does NOT count.
            // Looking is not acting, and a wrong bind buries the call in someone else's
            // ticket; a duplicate is recoverable because a human can merge.
            //
            // Ambiguity (two different tickets noted, or two updated) also falls through to
            // create, for the same reason.
            const findWorkedTicketId = (): number | null => {
              try {
                const turns: any[] = payload.transcript || [];
                const created: number[] = [];
                const noted: number[] = [];
                const updated: number[] = [];

                for (const turn of turns) {
                  // create_ticket: the new id is only in the RESULT, not the params.
                  for (const tr of (turn.tool_results || [])) {
                    const name: string = tr.tool_name || '';
                    if (!name.endsWith('autotask_create_ticket')) continue;
                    const value = tr.result_value;
                    if (typeof value !== 'string') continue;
                    try {
                      const text = JSON.parse(value)?.content?.[0]?.text;
                      const inner = typeof text === 'string' ? JSON.parse(text) : null;
                      const id = inner?.data?.id;
                      if (typeof id === 'number') created.push(id);
                    } catch { /* not parseable, skip */ }
                  }
                  // note / update: the ticket id is in the PARAMS. Intent counts even if the
                  // call errored - a failed update still tells us which ticket she meant.
                  for (const tc of (turn.tool_calls || [])) {
                    const name: string = tc.tool_name || '';
                    const raw = tc.params_as_json;
                    if (typeof raw !== 'string') continue;
                    let params: any = null;
                    try { params = JSON.parse(raw); } catch { continue; }
                    // Autotask tools are inconsistent about the casing of this argument.
                    const id = params?.ticketId ?? params?.ticketID;
                    if (typeof id !== 'number') continue;
                    if (name.endsWith('autotask_create_ticket_note')) noted.push(id);
                    else if (name.endsWith('autotask_update_ticket')) updated.push(id);
                  }
                }

                // Tier 1: a ticket she created. Always safe to note - she just made it.
                if (created.length > 0) return created[created.length - 1];
                // Tiers 2 and 3: bind only when unambiguous.
                for (const tier of [noted, updated]) {
                  const distinct = Array.from(new Set(tier));
                  if (distinct.length === 1) return distinct[0];
                  if (distinct.length > 1) return null; // ambiguous -> create, human merges
                }
                return null;
              } catch (e) {
                this.logger.warn('Call closure: tool-history scan failed', { err: (e as Error)?.message });
                return null;
              }
            };

            // ── locked_ticket_id: the deterministic bind (2026-08-15, Brian) ──
            // When the agent's tool assignments are configured, every create_ticket /
            // create_ticket_note writes the ticket id into the locked_ticket_id dynamic
            // variable, last write wins. Closure reads it here FIRST: no transcript
            // extraction, no scan, no guessing. Agents without the assignment simply
            // never send it and fall through to the existing paths unchanged.
            const lockedTicketId = parseInt(String(dynVars.locked_ticket_id ?? ''), 10);
            if (!existingTicketNumber && Number.isFinite(lockedTicketId) && lockedTicketId > 0 && lockedTicketId < 1000000) {
              try {
                await this.autotaskService.createTicketNote(lockedTicketId, {
                  title: 'Ivy Call Closure Update',
                  description,
                  noteType: 1,
                  publish: 2,
                });
                this.logger.info('Call closure: bound via locked_ticket_id', {
                  ticketId: lockedTicketId, conversationId: payload.conversation_id,
                });
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ticket_id: lockedTicketId, action: 'updated' }));
                return;
              } catch (bindErr) {
                this.logger.warn('Call closure: locked_ticket_id bind failed, falling through', {
                  ticketId: lockedTicketId, error: bindErr,
                });
              }
            }

            if (!existingTicketNumber) {
              const workedTicketId = findWorkedTicketId();
              if (workedTicketId) {
                try {
                  await this.autotaskService.createTicketNote(workedTicketId, {
                    title: 'Ivy Call Closure Update',
                    description,
                    noteType: 1,
                    publish: 2,
                  });
                  this.logger.info('Call closure: bound to ticket from tool history', {
                    ticketId: workedTicketId,
                    conversationId: payload.conversation_id,
                  });
                  res.writeHead(200, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify({
                    ticket_id: workedTicketId,
                    action: 'updated',
                  }));
                  return;
                } catch (bindErr) {
                  this.logger.warn('Call closure: tool-history bind failed, will create new', {
                    ticketId: workedTicketId,
                    error: bindErr,
                  });
                  // Fall through to create a new ticket
                }
              }
            }

            // -- Silent-caller binding: an identified caller who said nothing --
            // The caller hung up or never stated a reason, so there is no transcript for
            // EL to extract support_ticket_number from, and the block above could not
            // fire. But we still know who called. If they have exactly one recent open
            // ticket, that is overwhelmingly what the call was about; a fresh ticket
            // just splits the story. Measured 2026-07-26: 35 short calls in 9 days, 6
            // with identity AND open tickets, 4 with exactly one, and ZERO with a
            // support_ticket_number extracted.
            //
            // Strictly one candidate. With two or more, guessing is worse than a
            // duplicate: a wrong bind buries the call inside someone else's ticket.
            // publish=2 because the caller gave us nothing customer-facing to report.
            if (!existingTicketNumber && effectiveCompanyId && !hasRealCallReason) {
              try {
                const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
                const since = new Date(Date.now() - THIRTY_DAYS_MS).toISOString();
                const recent = await this.autotaskService.searchTickets({
                  companyId: effectiveCompanyId,
                  lastActivityAfter: since,
                } as any);
                const candidates = recent.filter(
                  tk => tk.status !== 5 && !EXCLUDED_QUEUE_IDS.has((tk as any).queueID)
                );
                if (candidates.length === 1) {
                  const only = candidates[0];
                  await this.autotaskService.createTicketNote(only.id!, {
                    title: 'Ivy Call Closure Update',
                    description,
                    noteType: 1,
                    publish: 2,
                  });
                  this.logger.info('Call closure: silent caller bound to sole open ticket', {
                    ticketId: only.id,
                    ticketNumber: only.ticketNumber,
                    companyId: effectiveCompanyId,
                    conversationId: payload.conversation_id,
                  });
                  res.writeHead(200, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify({
                    ticket_id: only.id,
                    ticket_number: only.ticketNumber,
                    action: 'updated',
                  }));
                  return;
                }
                this.logger.info('Call closure: silent caller, no sole candidate, creating', {
                  companyId: effectiveCompanyId,
                  candidateCount: candidates.length,
                  conversationId: payload.conversation_id,
                });
              } catch (bindErr) {
                this.logger.warn('Call closure: silent-caller bind failed, will create new', {
                  companyId: effectiveCompanyId,
                  error: bindErr,
                });
                // Fall through to create a new ticket
              }
            }

            // -- Resolve picklist IDs (cached after first call) --
            if (!this.ticketPicklistIds) {
              const statuses = await this.picklistCache.getTicketStatuses();
              const priorities = await this.picklistCache.getTicketPriorities();
              const newStatus = statuses.find(s => s.label.toLowerCase() === 'new');
              const normalPriority = priorities.find(p =>
                p.label.toLowerCase().includes('normal') || p.label.toLowerCase().includes('medium')
              );
              this.ticketPicklistIds = {
                statusNew: newStatus ? parseInt(newStatus.value) : 1,
                priorityNormal: normalPriority ? parseInt(normalPriority.value) : 2,
              };
              this.logger.info('Call closure: resolved picklist IDs', this.ticketPicklistIds);
            }

            // -- Create ticket --
            const ticket: Record<string, any> = {
              title,
              description,
              status: this.ticketPicklistIds.statusNew,
              priority: this.ticketPicklistIds.priorityNormal,
            };

            if (fullyIdentified) {
              ticket.companyID = effectiveCompanyId;
              ticket.contactID = effectiveContactId;
            } else if (companyOnlyIdentified) {
              ticket.companyID = effectiveCompanyId;
              // contactID omitted — UNVERIFIED INTAKE shape per kb_identity_sop
            } else {
              const defaultCompanyId = process.env.AUTOTASK_DEFAULT_COMPANY_ID;
              if (defaultCompanyId) {
                ticket.companyID = parseInt(defaultCompanyId);
              }
            }

            const ticketId = await this.autotaskService.createTicket(ticket);

            // Fetch the created ticket to get the ticket number
            let ticketNumber: string | null = null;
            try {
              const created = await this.autotaskService.getTicket(ticketId);
              ticketNumber = created?.ticketNumber || null;
            } catch {
              // Non-critical — we have the ID
            }

            this.logger.info('Call closure: ticket created', {
              ticketId,
              ticketNumber,
              conversationId: payload.conversation_id,
              identityLevel: fullyIdentified ? 'fully' : companyOnlyIdentified ? 'company_only' : 'unidentified',
            });

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              ticket_id: ticketId,
              ticket_number: ticketNumber,
              action: 'created',
            }));
          } catch (err) {
            this.logger.error('Call closure error:', err);
            if (!res.headersSent) {
              const message = err instanceof SyntaxError ? 'Invalid JSON body' : 'Internal error';
              const status = err instanceof SyntaxError ? 400 : 500;
              res.writeHead(status, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: message }));
            }
          }
        });
        return;
      }

      // 404 for everything else
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found', endpoints: ['/mcp', '/health', '/contact-lock', '/business-status', '/phone-lookup', '/resolve-extension', '/call-closure'] }));
    });

    await new Promise<void>((resolve) => {
      this.httpServer!.listen(port, host, () => {
        this.logger.info(`Autotask MCP Server listening on http://${host}:${port}/mcp`);
        this.logger.info(`Health check available at http://${host}:${port}/health`);
        this.logger.info(`Authentication mode: ${isGatewayMode ? 'gateway (header-based)' : 'env (environment variables)'}`);
        resolve();
      });
    });
  }

  /**
   * Extract credentials from gateway-injected HTTP headers
   */
  private extractGatewayCredentials(req: IncomingMessage): GatewayCredentials {
    const headers = req.headers as Record<string, string | string[] | undefined>;
    return parseCredentialsFromHeaders(headers);
  }

  /**
   * Update the Autotask service with new credentials
   * Used in gateway mode where credentials come from request headers
   */
  private updateCredentials(credentials: GatewayCredentials): void {
    // Re-create the service with new credentials
    // Build autotask config, only including defined values
    const autotaskConfig: McpServerConfig['autotask'] = {};
    if (credentials.username) {
      autotaskConfig.username = credentials.username;
    }
    if (credentials.secret) {
      autotaskConfig.secret = credentials.secret;
    }
    if (credentials.integrationCode) {
      autotaskConfig.integrationCode = credentials.integrationCode;
    }
    if (credentials.apiUrl) {
      autotaskConfig.apiUrl = credentials.apiUrl;
    }

    const newConfig: McpServerConfig = {
      name: this.envConfig?.server?.name || 'autotask-mcp',
      version: this.envConfig?.server?.version || '1.0.0',
      autotask: autotaskConfig
    };

    // Reinitialize service with new credentials
    this.autotaskService = new AutotaskService(newConfig, this.logger);
    this.resourceHandler = new AutotaskResourceHandler(this.autotaskService, this.logger);
    this.toolHandler = new AutotaskToolHandler(this.autotaskService, this.logger);
    this.toolHandler.setServer(this.server);

    this.logger.debug('Updated Autotask credentials from gateway headers');
  }

  /**
   * Stop the server gracefully
   */
  async stop(): Promise<void> {
    this.logger.info('Stopping Autotask MCP Server...');
    if (this.httpServer) {
      await new Promise<void>((resolve, reject) => {
        this.httpServer!.close((err) => err ? reject(err) : resolve());
      });
    }
    await this.server.close();
    this.logger.info('Autotask MCP Server stopped');
  }

  /**
   * Get server instructions for clients
   */
  private getServerInstructions(): string {
    return `
# Autotask MCP Server

This server provides access to Kaseya Autotask PSA data and operations through the Model Context Protocol.

## Available Resources:
- **autotask://companies/{id}** - Get company details by ID
- **autotask://companies** - List all companies
- **autotask://contacts/{id}** - Get contact details by ID  
- **autotask://contacts** - List all contacts
- **autotask://tickets/{id}** - Get ticket details by ID
- **autotask://tickets** - List all tickets

## Available Tools (39 total):
- Companies: search, create, update
- Contacts: search, create
- Tickets: search, get details, create
- Time entries: create
- Projects: search, create
- Resources: search
- Notes: get/search/create for tickets, projects, companies
- Attachments: get/search ticket attachments
- Financial: expense reports, quotes, invoices, contracts
- Configuration items: search
- Tasks: search, create
- Picklists: list queues, list ticket statuses, list ticket priorities, get field info
- Utility: test connection

## Picklist Discovery:
Use autotask_list_queues, autotask_list_ticket_statuses, or autotask_list_ticket_priorities to discover valid IDs before filtering. Use autotask_get_field_info for any entity's field definitions and picklist values.

## ID-to-Name Mapping:
All search and detail tools automatically include human-readable names for company and resource IDs in an _enhanced field on each result.

## Authentication:
This server requires valid Autotask API credentials. Ensure you have:
- AUTOTASK_USERNAME (API user email)
- AUTOTASK_SECRET (API secret key)
- AUTOTASK_INTEGRATION_CODE (integration code)

For more information, visit: https://github.com/wyre-technology/autotask-mcp
`.trim();
  }
}