/**
 * Shared types for the NuBerea SDK.
 */

// ============================================================================
// MCP Tool types
// ============================================================================

export interface ToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface ToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

// ============================================================================
// Analytics / Query types
// ============================================================================

export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  executionTimeMs: number;
  truncated: boolean;
  offset: number;
}

export type QueryFormat = 'json' | 'ndjson' | 'csv';

export interface TableInfo {
  table: string;
  columns: number;
  rowCount?: number;
}

export interface DatabaseInfo {
  name: string;
  description: string;
  tables: TableInfo[];
}

export interface ColumnInfo {
  column_name: string;
  column_type: string;
  null: string;
  key: string | null;
  default: string | null;
  extra: string | null;
}

export interface SchemaIntrospection {
  schema: string;
  description: string;
  tables: Array<{
    table: string;
    rowCount: number;
    columns: ColumnInfo[];
    sampleRows: Record<string, unknown>[];
  }>;
}

export interface StatsEntry {
  database: string;
  table: string;
  rowCount: number;
}
