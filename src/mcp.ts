/**
 * NuBerea MCP Client — Full MCP protocol implementation.
 *
 * Implements MCP Streamable HTTP transport:
 *   - POST /mcp: JSON-RPC requests (initialize, tools/list, tools/call, resources/list, resources/read)
 *   - Stateless requests authenticated independently with an OAuth bearer token
 *
 * Can be used standalone or through the higher-level NuBerea client class.
 */

import type { ToolInfo, ToolResult } from './types.js';
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

// ============================================================================
// MCP Protocol Types
// ============================================================================

export interface McpServerInfo {
  name: string;
  version: string;
}

export interface McpCapabilities {
  tools?: Record<string, unknown>;
  resources?: Record<string, unknown>;
  prompts?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface McpInitializeResult {
  protocolVersion: string;
  serverInfo: McpServerInfo;
  capabilities: McpCapabilities;
}

export interface McpResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface McpResourceContent {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
}

export interface McpResourceTemplate {
  uriTemplate: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
  _meta?: Record<string, unknown>;
}

const ResourceTemplatesPageSchema = Type.Object({
  resourceTemplates: Type.Array(Type.Object({
    uriTemplate: Type.String(), name: Type.String(),
    title: Type.Optional(Type.String()), description: Type.Optional(Type.String()),
    mimeType: Type.Optional(Type.String()),
    _meta: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  })),
  nextCursor: Type.Optional(Type.String()),
});

export interface McpJsonRpcRequest {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
  id: string | number;
}

export interface McpJsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface McpClientConfig {
  /** MCP endpoint URL */
  mcpUrl: string;
  /** Access token for Authorization header */
  accessToken: string;
  /** MCP protocol version (default: "2025-03-26") */
  protocolVersion?: string;
}

// ============================================================================
// MCP Client
// ============================================================================

export class McpClient {
  private mcpUrl: string;
  private accessToken: string;
  private protocolVersion: string;
  private initialized = false;
  private serverInfo: McpServerInfo | null = null;
  private capabilities: McpCapabilities | null = null;
  private requestId = 0;

  constructor(config: McpClientConfig) {
    this.mcpUrl = config.mcpUrl;
    this.accessToken = config.accessToken;
    this.protocolVersion = config.protocolVersion ?? '2025-03-26';
  }

  // ==========================================================================
  // Core JSON-RPC transport
  // ==========================================================================

  /**
   * Send a JSON-RPC request to the MCP server.
   * Handles both plain JSON and SSE response formats.
   */
  async request(method: string, params?: Record<string, unknown>): Promise<McpJsonRpcResponse> {
    const id = ++this.requestId;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${this.accessToken}`,
    };

    const body: McpJsonRpcRequest = {
      jsonrpc: '2.0',
      method,
      id,
      ...(params ? { params } : {}),
    };

    const res = await fetch(this.mcpUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      redirect: 'error',
    });

    if (!res.ok) {
      const text = await res.text();
      throw new McpError(`MCP request failed: HTTP ${res.status} — ${text}`, res.status);
    }

    // Parse response (may be SSE or plain JSON)
    const text = await res.text();
    const response = this.parseResponse(text, res.headers.get('content-type') ?? '');
    if (response.jsonrpc !== '2.0' || response.id !== id
      || (Object.hasOwn(response, 'result') === Object.hasOwn(response, 'error'))) {
      throw new McpError('Invalid or mismatched MCP JSON-RPC response', -32603);
    }
    return response;
  }

  /**
   * Send a JSON-RPC notification (no id, no response expected).
   */
  async notify(method: string, params?: Record<string, unknown>): Promise<void> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${this.accessToken}`,
    };

    const body = {
      jsonrpc: '2.0' as const,
      method,
      ...(params ? { params } : {}),
    };

    const response = await fetch(this.mcpUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      redirect: 'error',
    });
    if (!response.ok) throw new McpError(`MCP notification failed: HTTP ${response.status}`, response.status);
  }

  // ==========================================================================
  // MCP Protocol Methods
  // ==========================================================================

  /**
   * Perform the optional MCP initialize handshake.
   */
  async initialize(): Promise<McpInitializeResult> {
    const res = await this.request('initialize', {
      protocolVersion: this.protocolVersion,
      clientInfo: {
        name: '@nuberea/sdk',
        version: '0.2.0',
      },
      capabilities: {},
    });

    if (res.error) {
      throw new McpError(`Initialize failed: ${res.error.message}`, res.error.code);
    }

    const result = res.result as McpInitializeResult;
    this.serverInfo = result.serverInfo;
    this.capabilities = result.capabilities;
    this.initialized = true;

    // Send initialized notification
    await this.notify('notifications/initialized');

    return result;
  }

  /**
   * List available tools.
   */
  async listTools(): Promise<ToolInfo[]> {
    const res = await this.request('tools/list');
    if (res.error) {
      throw new McpError(`tools/list failed: ${res.error.message}`, res.error.code);
    }

    const result = res.result as { tools: ToolInfo[] };
    return result.tools;
  }

  /**
   * Call a tool by name.
   */
  async callTool(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
    const res = await this.request('tools/call', { name, arguments: args });
    if (res.error) {
      throw new McpError(`tools/call failed: ${res.error.message}`, res.error.code);
    }

    return res.result as ToolResult;
  }

  /**
   * List available resources.
   */
  async listResources(): Promise<McpResource[]> {
    const res = await this.request('resources/list');
    if (res.error) {
      throw new McpError(`resources/list failed: ${res.error.message}`, res.error.code);
    }

    const result = res.result as { resources: McpResource[] };
    return result.resources;
  }

  async listResourceTemplates(): Promise<McpResourceTemplate[]> {
    const templates: McpResourceTemplate[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const response = await this.request('resources/templates/list', cursor === undefined ? undefined : { cursor });
      if (response.error) throw new McpError(response.error.message, response.error.code);
      if (!Value.Check(ResourceTemplatesPageSchema, response.result)) {
        throw new McpError('Invalid resources/templates/list response', -32603);
      }
      templates.push(...response.result.resourceTemplates);
      cursor = response.result.nextCursor;
      if (cursor !== undefined) {
        if (cursors.has(cursor)) throw new McpError('Repeated resource-template cursor', -32603);
        cursors.add(cursor);
      }
    } while (cursor !== undefined);
    return templates;
  }

  /**
   * Read a resource by URI.
   */
  async readResource(uri: string): Promise<McpResourceContent[]> {
    const res = await this.request('resources/read', { uri });
    if (res.error) {
      throw new McpError(`resources/read failed: ${res.error.message}`, res.error.code);
    }

    const result = res.result as { contents: McpResourceContent[] };
    return result.contents;
  }

  /**
   * Reset locally cached initialize metadata.
   */
  async close(): Promise<void> {
    this.initialized = false;
    this.serverInfo = null;
    this.capabilities = null;
  }

  getServerInfo(): McpServerInfo | null {
    return this.serverInfo;
  }

  getCapabilities(): McpCapabilities | null {
    return this.capabilities;
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Update the access token (e.g., after refresh).
   */
  setAccessToken(token: string): void {
    this.accessToken = token;
  }

  private parseResponse(text: string, contentType: string): McpJsonRpcResponse {
    // SSE format: extract last "data:" line with a parseable JSON-RPC response
    if (contentType.includes('text/event-stream')) {
      const lines = text.split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        if (line.startsWith('data: ')) {
          try {
            const parsed = JSON.parse(line.slice(6));
            if (parsed.jsonrpc === '2.0') return parsed;
          } catch {
            continue;
          }
        }
      }
      throw new McpError('No valid JSON-RPC response in SSE stream', -1);
    }

    // Plain JSON
    try {
      return JSON.parse(text) as McpJsonRpcResponse;
    } catch {
      throw new McpError(`Invalid JSON response: ${text.substring(0, 200)}`, -1);
    }
  }
}

// ============================================================================
// Error class
// ============================================================================

export class McpError extends Error {
  code: number;

  constructor(message: string, code: number) {
    super(message);
    this.name = 'McpError';
    this.code = code;
  }
}
