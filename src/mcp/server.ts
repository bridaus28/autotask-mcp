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
import { PicklistCache } from '../services/picklist.cache.js';

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
  private createFreshServer(): Server {
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

    this.setupHandlers(server);
    this.toolHandler.setServer(server);

    return server;
  }

  /**
   * Set up all MCP request handlers
   */
  private setupHandlers(server: Server): void {
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
        this.logger.debug('Handling list tools request');
        const tools = await this.toolHandler.listTools();
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

        // Stateless: create fresh server + transport for each request
        const server = this.createFreshServer();
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
            const contactId = parseInt(String(parsed.contact_id), 10);
            if (!contactId || isNaN(contactId)) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'contact_id (integer) required' }));
              return;
            }

            const contact = await this.autotaskService.getContact(contactId);
            if (!contact) {
              res.writeHead(404, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Contact not found' }));
              return;
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              contact_id: contact.id ?? contactId,
              company_id: contact.companyID ?? null,
              first_name: contact.firstName ?? null,
              last_name: contact.lastName ?? null,
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
                ambiguousCandidates: null,
              }));
              return;
            }

            // ── 1. Always start with contact search ──────────────────────────
            const contacts = await this.autotaskService.searchContacts({ phone });

            const contactOut = (c: any) => ({
              id:        c.id,
              firstName: c.firstName ?? null,
              lastName:  c.lastName  ?? null,
              companyID: c.companyID ?? null,
              phone:     c.phone     ?? null,
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

            // Build enriched company block for a given companyID.
            const buildCompanyBlock = async (companyID: number) => {
              const company = await this.autotaskService.getCompany(companyID);
              if (!company) return null;
              const cls = await resolveClassification((company as any).classification);
              return {
                id: company.id ?? companyID,
                name: company.companyName ?? null,
                classification: cls.label,
                isManaged: cls.isManaged,
              };
            };

            // Build open-ticket list for a company. Picklist-resolves status label
            // and looks up assignee resource name. Top 5 by lastActivityDate desc.
            // Filters out tickets with status=5 (Complete) client-side.
            const buildOpenTickets = async (companyID: number) => {
              try {
                // Server-side sort by lastActivityDate desc — Autotask default is ID asc,
                // which would return the oldest records first and miss newer activity above pageSize.
                const tickets = await this.autotaskService.searchTickets({
                  companyId: companyID,
                  pageSize: 25,
                  sort: [{ field: 'lastActivityDate', direction: 'desc' }],
                } as any);

                // status=5 (Complete) filtered client-side; server-side sort already handled ordering.
                const openTickets = tickets
                  .filter(t => t.status !== 5)
                  .slice(0, 5);

                if (openTickets.length === 0) return [];

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

                return openTickets.map((t: any) => ({
                  number:        t.ticketNumber ?? null,
                  title:         t.title ?? null,
                  statusLabel:   statusMap.get(String(t.status)) ?? null,
                  assigneeName:  t.assignedResourceID ? (assigneeNames.get(t.assignedResourceID) ?? null) : null,
                  lastActivity:  t.lastActivityDate ?? null,
                }));
              } catch (e) {
                this.logger.warn('Open ticket fetch failed', { companyID, err: (e as Error)?.message });
                return [];
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
                  ambiguousCandidates: null,
                }));
                return;
              }
              // Case 4: company main phone match. Take the first (most common case).
              const primaryCompany = companies[0];
              const companyID = primaryCompany.id as number;
              const [companyBlock, openTickets] = await Promise.all([
                buildCompanyBlock(companyID),
                buildOpenTickets(companyID),
              ]);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({
                match_type: 'company_main_phone',
                count: 0,
                contacts: [],
                company: companyBlock,
                openTickets,
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
                };
              });

              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({
                match_type: 'ambiguous_multi_company',
                count: contacts.length,
                contacts: contacts.map(contactOut),
                company: null,
                openTickets: [],
                ambiguousCandidates,
              }));
              return;
            }

            // Cases 1 & 2: single company (whether one contact or several at same company).
            const companyID = uniqueCompanyIDs[0];
            const [companyBlock, openTickets] = companyID
              ? await Promise.all([buildCompanyBlock(companyID), buildOpenTickets(companyID)])
              : [null, []];

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              match_type: contacts.length === 1 ? 'exact_contact' : 'multi_contact_one_company',
              count: contacts.length,
              contacts: contacts.map(contactOut),
              company: companyBlock,
              openTickets,
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

            const sipUri = `sip:${ext}@cvit.bvoip.net`;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ sip_uri: sipUri, extension: ext }));
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
            const callerIdentified = !!(confirmedContactId && confirmedCompanyId && !isNaN(confirmedContactId) && !isNaN(confirmedCompanyId));

            const rawCallReason = dataCollection.call_reason?.value ?? null;
            const hasRealCallReason = rawCallReason && rawCallReason.toLowerCase() !== 'none' && rawCallReason.trim() !== '';

            if (!callerIdentified && !hasRealCallReason) {
              this.logger.info('Call closure: skipped — no identified caller and no call reason', {
                conversationId: payload.conversation_id,
              });
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ action: 'skipped', reason: 'No identified caller and no call reason' }));
              return;
            }

            // -- Build ticket fields --
            const callReason = rawCallReason || 'General Inquiry';
            const callerName = callerIdentified
              ? [dynVars.confirmed_first_name, dynVars.confirmed_last_name].filter(Boolean).join(' ') || 'Unknown Caller'
              : 'Unidentified Caller';
            const callerPhone = phoneCall.external_number || dynVars.caller_phone || 'Unknown';
            const durationSecs = metadata.call_duration_secs || null;
            const durationStr = durationSecs != null ? `${Math.ceil(durationSecs / 60)} min (${durationSecs}s)` : 'Unknown';
            const summary = analysis.transcript_summary || 'No summary available.';
            const transferredTo = dataCollection.call_routed_to?.value ?? null;
            const businessStatus = dynVars.business_status || 'Unknown';
            const termination = metadata.termination_reason || 'unknown';
            const callOutcome = analysis.call_successful || 'unknown';

            const title = callerIdentified
              ? `Inbound Call: ${callReason} - ${callerName}`.substring(0, 255)
              : `Inbound Call: ${callReason} - Unidentified (${callerPhone})`.substring(0, 255);

            const descriptionLines = [
              '== Ivy Call Closure Report ==',
              '',
              `Summary: ${summary}`,
              '',
              `Call Reason: ${callReason}`,
              `Caller: ${callerName}`,
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
                    publish: 1,  // Internal Only
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

            if (callerIdentified) {
              ticket.companyID = confirmedCompanyId;
              ticket.contactID = confirmedContactId;
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
              callerIdentified,
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