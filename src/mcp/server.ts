// Main MCP Server Implementation
// Handles the Model Context Protocol server setup and integration with Autotask
// Supports both local (env-based) and gateway (header-based) credential modes

import { createServer, IncomingMessage, ServerResponse, Server as HttpServer } from 'node:http';
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

export class AutotaskMcpServer {
  private server: Server;
  private config: McpServerConfig;
  private autotaskService: AutotaskService;
  private resourceHandler: AutotaskResourceHandler;
  private toolHandler: AutotaskToolHandler;
  private logger: Logger;
  private envConfig: EnvironmentConfig | undefined;
  private httpServer?: HttpServer;

  constructor(config: McpServerConfig, logger: Logger, envConfig?: EnvironmentConfig) {
    this.logger = logger;
    this.config = config;
    this.envConfig = envConfig;

    // Initialize Autotask service
    this.autotaskService = new AutotaskService(config, logger);

    // Initialize handlers
    this.resourceHandler = new AutotaskResourceHandler(this.autotaskService, logger);
    this.toolHandler = new AutotaskToolHandler(this.autotaskService, logger);

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

      // Bearer token auth — required for all endpoints except /health
      const sharedSecret = process.env.RAILWAY_SHARED_SECRET;
      if (sharedSecret) {
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

      // Phone lookup endpoint — wraps autotask_search_contacts for Twilio call-init.
      // Returns contact candidates so Twilio can inject them as a dynamic variable
      // before ElevenLabs starts the conversation.
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
            if (!phone) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'phone required' }));
              return;
            }

            const contacts = await this.autotaskService.searchContacts({ phone });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              count: contacts.length,
              contacts: contacts.map((c: any) => ({
                id:        c.id,
                firstName: c.firstName ?? null,
                lastName:  c.lastName  ?? null,
                companyID: c.companyID ?? null,
                phone:     c.phone     ?? null,
              })),
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

      // 404 for everything else
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found', endpoints: ['/mcp', '/health', '/contact-lock', '/business-status', '/phone-lookup'] }));
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