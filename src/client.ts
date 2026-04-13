/**
 * NuBerea Client — Main SDK entry point.
 *
 * Wraps authentication, MCP tool calls, and REST analytics queries
 * into a single, ergonomic interface.
 */

import { NuBereaAuth, type AuthConfig } from './auth.js';
import type {
  ToolResult,
  ToolInfo,
  QueryResult,
  QueryFormat,
  DatabaseInfo,
  ColumnInfo,
  SchemaIntrospection,
  StatsEntry,
} from './types.js';

export interface NuBereaConfig {
  /** OAuth / MCP server configuration */
  auth?: Partial<AuthConfig>;
  /** Override: OAuth server base URL */
  baseUrl?: string;
  /** Override: MCP endpoint URL */
  mcpUrl?: string;
  /** Pre-set access token (skip login) */
  accessToken?: string;
  /** Pre-set Firebase token (skip browser sign-in) */
  firebaseToken?: string;
}

export type NuBereaTokens = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
};

const DEFAULT_BASE = 'https://auth.aws-dev.streamsappsgslbex.com';

export class NuBerea {
  private auth: NuBereaAuth;
  private baseUrl: string;
  private mcpUrl: string;
  private staticToken: string | undefined;
  private firebaseToken: string | undefined;

  constructor(config?: NuBereaConfig) {
    this.baseUrl = config?.baseUrl ?? config?.auth?.oauthBaseUrl ?? DEFAULT_BASE;
    this.mcpUrl = config?.mcpUrl ?? config?.auth?.mcpUrl ?? `${this.baseUrl}/mcp`;
    this.staticToken = config?.accessToken;
    this.firebaseToken = config?.firebaseToken;

    this.auth = new NuBereaAuth({
      oauthBaseUrl: this.baseUrl,
      mcpUrl: this.mcpUrl,
      ...config?.auth,
    });
  }

  // ==========================================================================
  // Auth
  // ==========================================================================

  /**
   * Authenticate with the NuBerea platform.
   * Opens a browser for Firebase sign-in if no token is cached.
   */
  async login(): Promise<void> {
    if (this.staticToken) return;
    await this.auth.login(this.firebaseToken);
  }

  /**
   * Check if the client has valid credentials.
   */
  isAuthenticated(): boolean {
    return !!this.staticToken || this.auth.isAuthenticated();
  }

  /**
   * Clear stored credentials.
   */
  logout(): void {
    this.staticToken = undefined;
    this.auth.logout();
  }

  private async getToken(): Promise<string> {
    if (this.staticToken) return this.staticToken;
    return this.auth.getAccessToken();
  }

  // ==========================================================================
  // MCP Tools
  // ==========================================================================

  /**
   * List all available MCP tools.
   */
  async tools(): Promise<ToolInfo[]> {
    const res = await fetch(`${this.baseUrl}/tools`);
    if (!res.ok) throw new Error(`Failed to list tools: HTTP ${res.status}`);
    const data = (await res.json()) as { tools: ToolInfo[] };
    return data.tools;
  }

  /**
   * Call an MCP tool by name.
   *
   * @example
   * ```ts
   * const result = await client.tool('bible_kjv_get_verse', {
   *   book: 'John', chapter: 1, verse: 1,
   * });
   * console.log(result.content[0].text);
   * ```
   */
  async tool(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
    const token = await this.getToken();

    const res = await fetch(this.mcpUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name, arguments: args },
        id: Date.now(),
      }),
    });

    if (!res.ok) {
      throw new Error(`MCP tool call failed: HTTP ${res.status} — ${await res.text()}`);
    }

    const text = await res.text();
    const parsed = this.parseMcpResponse(text, res.headers.get('content-type') ?? '');

    if (parsed.error) {
      throw new Error(`MCP error: ${JSON.stringify(parsed.error)}`);
    }

    return (parsed.result as ToolResult) ?? { content: [] };
  }

  /**
   * Call an MCP tool and return just the text content (convenience).
   */
  async toolText(name: string, args: Record<string, unknown> = {}): Promise<string> {
    const result = await this.tool(name, args);
    const textContent = result.content.find((c) => c.type === 'text');
    return textContent?.text ?? '';
  }

  /**
   * Call an MCP tool and parse the text content as JSON (convenience).
   */
  async toolJson<T = unknown>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const text = await this.toolText(name, args);
    return JSON.parse(text) as T;
  }

  // ==========================================================================
  // Analytics / SQL queries
  // ==========================================================================

  /**
   * Execute a SQL query against the unified data platform.
   *
   * @example
   * ```ts
   * const result = await client.query(
   *   "SELECT * FROM hebrew.morphemes WHERE book_id = 'Gen' AND chapter = 1 LIMIT 10"
   * );
   * ```
   */
  async query(
    sql: string,
    options?: { limit?: number; offset?: number; timeout?: number; format?: QueryFormat },
  ): Promise<QueryResult> {
    const result = await this.tool('analytics_query', {
      sql,
      limit: options?.limit ?? 100,
    });

    const text = result.content.find((c) => c.type === 'text')?.text ?? '';

    // analytics_query returns "<summary>\n\n<json>" — extract the JSON part
    const jsonStart = text.indexOf('[');
    if (jsonStart === -1) {
      // Might be an error or empty result
      return {
        columns: [],
        rows: [],
        rowCount: 0,
        executionTimeMs: 0,
        truncated: false,
        offset: 0,
      };
    }

    const summaryLine = text.substring(0, jsonStart).trim();
    const rows = JSON.parse(text.substring(jsonStart)) as Record<string, unknown>[];
    const columns = rows.length > 0 ? Object.keys(rows[0]) : [];

    // Parse summary: "N rows returned in Xms (truncated)"
    const truncated = summaryLine.includes('truncated');
    const timeMatch = summaryLine.match(/in (\d+)ms/);
    const executionTimeMs = timeMatch ? parseInt(timeMatch[1], 10) : 0;

    return {
      columns,
      rows,
      rowCount: rows.length,
      executionTimeMs,
      truncated,
      offset: options?.offset ?? 0,
    };
  }

  /**
   * List all available databases (schemas) and their tables.
   */
  async databases(): Promise<DatabaseInfo[]> {
    const result = await this.tool('analytics_list_databases');
    const text = result.content.find((c) => c.type === 'text')?.text ?? '{}';
    const data = JSON.parse(text) as { databases: DatabaseInfo[] };
    return data.databases;
  }

  /**
   * Describe a table's columns.
   */
  async describe(database: string, table: string): Promise<ColumnInfo[]> {
    const result = await this.tool('analytics_describe_table', { database, table });
    const text = result.content.find((c) => c.type === 'text')?.text ?? '{}';
    const data = JSON.parse(text) as { columns: ColumnInfo[] };
    return data.columns;
  }

  /**
   * Deep introspection of a schema — tables, columns, row counts, sample rows.
   */
  async introspect(schema: string, table?: string): Promise<SchemaIntrospection> {
    const args: Record<string, unknown> = { schema };
    if (table) args.table = table;
    const result = await this.tool('analytics_schema_introspect', args);
    const text = result.content.find((c) => c.type === 'text')?.text ?? '{}';
    return JSON.parse(text) as SchemaIntrospection;
  }

  /**
   * Get row counts for all tables.
   */
  async stats(): Promise<StatsEntry[]> {
    const result = await this.tool('analytics_list_databases');
    // This returns the databases list; we'd need a stats tool or use query
    const text = result.content.find((c) => c.type === 'text')?.text ?? '{}';
    const data = JSON.parse(text) as { databases: DatabaseInfo[] };
    return data.databases.flatMap((db) =>
      db.tables.map((t) => ({
        database: db.name,
        table: t.table,
        rowCount: t.rowCount ?? 0,
      })),
    );
  }

  // ==========================================================================
  // Convenience methods (typed shortcuts for common tools)
  // ==========================================================================

  /** Get a KJV verse */
  async verse(book: string, chapter: number, verse: number): Promise<string> {
    return this.toolText('bible_kjv_get_verse', { book, chapter, verse });
  }

  /** Search KJV text */
  async search(text: string, limit = 10): Promise<string> {
    return this.toolText('bible_kjv_search_text', { query: text, limit });
  }

  /** Look up a Greek word in LSJ */
  async greekLookup(term: string): Promise<string> {
    return this.toolText('lexicon_lsj_lookup', { term });
  }

  /** Look up a Hebrew word in BDB by Strong's number */
  async hebrewStrong(strong: string): Promise<string> {
    return this.toolText('lexicon_bdb_search_strong', { strong });
  }

  /** Get Hebrew morphology for a verse */
  async hebrewMorphology(book: string, chapter: number, verse: number): Promise<string> {
    return this.toolText('macula_hebrew_query_verse', { book, chapter, verse });
  }

  /** Get Greek morphology for a verse */
  async greekMorphology(book: string, chapter: number, verse: number): Promise<string> {
    return this.toolText('macula_greek_query_verse', { book, chapter, verse });
  }

  // ==========================================================================
  // Internal
  // ==========================================================================

  private parseMcpResponse(
    text: string,
    contentType: string,
  ): { result?: unknown; error?: unknown } {
    // SSE format: look for last "data: " line
    if (contentType.includes('text/event-stream')) {
      for (const line of text.split('\n').reverse()) {
        if (line.startsWith('data: ')) {
          try {
            return JSON.parse(line.slice(6));
          } catch {
            continue;
          }
        }
      }
      return { error: 'No parseable SSE data' };
    }

    // Plain JSON
    return JSON.parse(text);
  }
}
