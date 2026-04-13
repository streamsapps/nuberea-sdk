/**
 * NuBerea SDK
 *
 * Client library for the NuBerea biblical data platform.
 * Supports both MCP (Model Context Protocol) and REST query interfaces.
 *
 * @example
 * ```ts
 * import { NuBerea } from '@nuberea/sdk';
 *
 * const client = new NuBerea();
 * await client.login();
 *
 * // Call any MCP tool
 * const result = await client.tool('bible_kjv_get_verse', {
 *   book: 'John', chapter: 1, verse: 1,
 * });
 *
 * // Run SQL analytics
 * const rows = await client.query(
 *   'SELECT * FROM hebrew.morphemes WHERE book_id = \'Gen\' AND chapter = 1 LIMIT 10'
 * );
 *
 * // List available tools
 * const tools = await client.tools();
 * ```
 */

export { NuBerea } from './client.js';
export type { NuBereaConfig, NuBereaTokens } from './client.js';
export { NuBereaAuth } from './auth.js';
export type { AuthConfig } from './auth.js';
export { McpClient, McpError } from './mcp.js';
export type {
  McpClientConfig,
  McpServerInfo,
  McpCapabilities,
  McpInitializeResult,
  McpResource,
  McpResourceContent,
  McpJsonRpcRequest,
  McpJsonRpcResponse,
} from './mcp.js';
export type {
  ToolResult,
  ToolInfo,
  QueryResult,
  DatabaseInfo,
  TableInfo,
  ColumnInfo,
  SchemaIntrospection,
} from './types.js';
