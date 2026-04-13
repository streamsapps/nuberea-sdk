/**
 * NuBerea MCP Client — Full MCP protocol implementation.
 *
 * Implements MCP Streamable HTTP transport:
 *   - POST /mcp: JSON-RPC requests (initialize, tools/list, tools/call, resources/list, resources/read)
 *   - Session tracking via mcp-session-id header
 *   - Stateless mode (no session) and session-based mode
 *
 * Can be used standalone or through the higher-level NuBerea client class.
 */

import type { ToolInfo, ToolResult } from './types.js';

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
  /** Use session-based mode (sends initialize, tracks session ID) */
  useSession?: boolean;
}

// ============================================================================
// MCP Client
// ============================================================================

export class McpClient {
  private mcpUrl: string;
  private accessToken: string;
  private protocolVersion: string;
  private sessionId: string | null = null;
  private initialized = false;
  private serverInfo: McpServerInfo | null = null;
  private capabilities: McpCapabilities | null = null;
  private useSession: boolean;
  private requestId = 0;

  constructor(config: McpClientConfig) {
    this.mcpUrl = config.mcpUrl;
    this.accessToken = config.accessToken;
    this.protocolVersion = config.protocolVersion ?? '2025-03-26';
    this.useSession = config.useSession ?? false;
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

    if (this.sessionId) {
      headers['mcp-session-id'] = this.sessionId;
    }

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
    });

    if (!res.ok) {
      const text = await res.text();
      throw new McpError(`MCP request failed: HTTP ${res.status} — ${text}`, res.status);
    }

    // Capture session ID from response
    const newSessionId = res.headers.get('mcp-session-id');
    if (newSessionId) {
      this.sessionId = newSessionId;
    }

    // Parse response (may be SSE or plain JSON)
    const text = await res.text();
    return this.parseResponse(text, res.headers.get('content-type') ?? '');
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

    if (this.sessionId) {
      headers['mcp-session-id'] = this.sessionId;
    }

    const body = {
      jsonrpc: '2.0' as const,
      method,
      ...(params ? { params } : {}),
    };

    await fetch(this.mcpUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
  }

  // ==========================================================================
  // MCP Protocol Methods
  // ==========================================================================

  /**
   * Initialize the MCP session.
   * Must be called before other methods in session-based mode.
   */
  async initialize(): Promise<McpInitializeResult> {
    const res = await this.request('initialize', {
      protocolVersion: this.protocolVersion,
      clientInfo: {
        name: '@nuberea/sdk',
        version: '0.1.0',
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
    await this.ensureReady();

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
    await this.ensureReady();

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
    await this.ensureReady();

    const res = await this.request('resources/list');
    if (res.error) {
      throw new McpError(`resources/list failed: ${res.error.message}`, res.error.code);
    }

    const result = res.result as { resources: McpResource[] };
    return result.resources;
  }

  /**
   * Read a resource by URI.
   */
  async readResource(uri: string): Promise<McpResourceContent[]> {
    await this.ensureReady();

    const res = await this.request('resources/read', { uri });
    if (res.error) {
      throw new McpError(`resources/read failed: ${res.error.message}`, res.error.code);
    }

    const result = res.result as { contents: McpResourceContent[] };
    return result.contents;
  }

  /**
   * Close the MCP session (sends DELETE request).
   */
  async close(): Promise<void> {
    if (!this.sessionId) return;

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.accessToken}`,
      'mcp-session-id': this.sessionId,
    };

    try {
      await fetch(this.mcpUrl, { method: 'DELETE', headers });
    } catch {
      // Best-effort cleanup
    }

    this.sessionId = null;
    this.initialized = false;
  }

  // ==========================================================================
  // Accessors
  // ==========================================================================

  getSessionId(): string | null {
    return this.sessionId;
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

  // ==========================================================================
  // Internal
  // ==========================================================================

  private async ensureReady(): Promise<void> {
    if (this.useSession && !this.initialized) {
      await this.initialize();
    }
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
