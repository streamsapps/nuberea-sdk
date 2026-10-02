import type { ParamBinding, ToolInputSchema } from './types.js';

export type SqlColumnType = 'boolean' | 'integer' | 'decimal' | 'number' | 'string'
  | 'date' | 'time' | 'timestamp' | 'binary' | 'json' | 'unknown';
export type SqlCellValue = string | number | boolean | null | {
  type: 'int64' | 'decimal' | 'date' | 'time' | 'timestamp' | 'binary' | 'json';
  value: string;
};
export interface SqlColumn {
  name: string;
  type: SqlColumnType;
  sourceType: string;
  nullable?: boolean;
}
export interface RegisteredQuery {
  toolId: string;
  name: string;
  description: string;
  sql: string;
  inputSchema: ToolInputSchema;
  parameters: Record<string, ParamBinding>;
  rowLimit: number;
}
export interface SourceDescription {
  id: string;
  name: string;
  group: 'nuberea' | 'catalog' | 'hugging-face';
  status: 'available' | 'pending' | 'denied' | 'stale' | 'unavailable';
  statusMessage?: string;
  dialect: string;
  /** Registry/configuration fingerprint, not an immutable dataset snapshot. */
  revision: string;
  schemaRevision: string;
  tables: Array<{ name: string; columns: Array<{ name: string; type: string; nullable?: boolean }> }>;
  capabilities: {
    readonlyExecution: boolean;
    localPreview: false;
    sameEngineJoins: boolean;
    maxRows: number;
    maxBytes: number;
    maxTimeoutMs: number;
    registeredQueriesOnly: true;
    immutableSnapshot: false;
    cancellation: false;
    offset: false;
    idempotency: false;
  };
  registeredQueries: RegisteredQuery[];
}
export interface SourceBinding {
  bindingId: string;
  sourceId: string;
  sourceRevision: string;
  schemaRevision: string;
  dialect: string;
  expiresAt: string;
  execution: { kind: 'registered-tool'; toolId: string; toolName: string; templateHash: string };
}
export interface SqlQueryRequest {
  queryId: string;
  binding: SourceBinding;
  sql: string;
  parameters: Record<string, unknown>;
  rowLimit?: number;
  timeoutMs?: number;
  mode: 'remote';
}
export interface SqlQueryResult {
  queryId: string;
  status: 'succeeded';
  columns: SqlColumn[];
  rows: SqlCellValue[][];
  rowCount: number;
  totalRowCount?: number;
  byteCount: number;
  truncated: boolean;
  sampled: boolean;
  elapsedMs: number;
  bindingId: string;
  sourceRevision: string;
  queryHash?: string;
  artifactId?: string;
}
export interface SqlStudioClientConfig {
  /** MCP host, without /mcp or /v1; requires credential-free HTTPS. */
  baseUrl: string;
  getToken: () => Promise<string>;
  fetcher?: typeof fetch;
}
export class SqlStudioError extends Error {
  constructor(message: string, readonly code: string, readonly status: number, readonly details: string[] = []) {
    super(message);
    this.name = 'SqlStudioError';
  }
}

const record = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const nonempty = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const nullable = (v: Record<string, unknown>) => v.nullable === undefined || typeof v.nullable === 'boolean';
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
function invalid(kind: string): never {
  throw new SqlStudioError(`Invalid SQL ${kind} response`, 'INVALID_RESPONSE', 502);
}

export function parseSourceDescription(value: unknown): SourceDescription {
  if (!record(value) || !nonempty(value.id) || !nonempty(value.name)
    || !['nuberea', 'catalog', 'hugging-face'].includes(String(value.group))
    || !['available', 'pending', 'denied', 'stale', 'unavailable'].includes(String(value.status))
    || !nonempty(value.dialect) || !hash(value.revision) || !hash(value.schemaRevision)
    || (value.statusMessage !== undefined && typeof value.statusMessage !== 'string')
    || !Array.isArray(value.tables) || !record(value.capabilities) || !Array.isArray(value.registeredQueries)) return invalid('source');
  for (const table of value.tables) {
    if (!record(table) || !nonempty(table.name) || !Array.isArray(table.columns)) return invalid('schema');
    if (table.columns.some((c) => !record(c) || !nonempty(c.name) || !nonempty(c.type) || !nullable(c))) return invalid('schema');
  }
  const caps = value.capabilities;
  if (typeof caps.readonlyExecution !== 'boolean' || caps.localPreview !== false
    || typeof caps.sameEngineJoins !== 'boolean' || !count(caps.maxRows) || !count(caps.maxBytes)
    || !count(caps.maxTimeoutMs) || caps.registeredQueriesOnly !== true || caps.immutableSnapshot !== false
    || caps.cancellation !== false || caps.offset !== false || caps.idempotency !== false) return invalid('capabilities');
  for (const q of value.registeredQueries) {
    if (!record(q) || !nonempty(q.toolId) || !nonempty(q.name) || typeof q.description !== 'string'
      || !nonempty(q.sql) || !count(q.rowLimit) || q.rowLimit === 0
      || !record(q.inputSchema) || q.inputSchema.type !== 'object' || !record(q.inputSchema.properties)
      || !record(q.parameters)) return invalid('registered query');
    const properties = q.inputSchema.properties;
    if (q.inputSchema.required !== undefined && (!Array.isArray(q.inputSchema.required)
      || q.inputSchema.required.some((x) => typeof x !== 'string' || !Object.hasOwn(properties, x)))) return invalid('parameter schema');
    for (const p of Object.values(q.inputSchema.properties)) {
      if (!record(p) || !['string', 'integer', 'number', 'boolean', 'array', 'object'].includes(String(p.type))
        || (p.enum !== undefined && (!Array.isArray(p.enum) || p.enum.some((x) => typeof x !== 'string' && typeof x !== 'number')))) return invalid('parameter schema');
    }
    for (const p of Object.values(q.parameters)) {
      if (!record(p) || !nonempty(p.sqlParam) || !['string', 'integer', 'number', 'boolean', 'date'].includes(String(p.type))
        || (p.max !== undefined && (typeof p.max !== 'number' || !Number.isFinite(p.max) || p.max < 0))) return invalid('parameter binding');
    }
  }
  return value as unknown as SourceDescription;
}

export function parseSourceBinding(value: unknown): SourceBinding {
  if (!record(value) || !nonempty(value.bindingId) || !nonempty(value.sourceId)
    || !hash(value.sourceRevision) || !hash(value.schemaRevision) || !nonempty(value.dialect)
    || typeof value.expiresAt !== 'string' || !Number.isFinite(Date.parse(value.expiresAt))
    || !record(value.execution) || value.execution.kind !== 'registered-tool'
    || !nonempty(value.execution.toolId) || !nonempty(value.execution.toolName) || !hash(value.execution.templateHash)) return invalid('binding');
  return value as unknown as SourceBinding;
}

const columnTypes = new Set(['boolean', 'integer', 'decimal', 'number', 'string', 'date', 'time', 'timestamp', 'binary', 'json', 'unknown']);
const taggedTypes = new Set(['int64', 'decimal', 'date', 'time', 'timestamp', 'binary', 'json']);
function cell(v: unknown): v is SqlCellValue {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return true;
  if (typeof v === 'number') return Number.isFinite(v) && (!Number.isInteger(v) || Number.isSafeInteger(v));
  if (!record(v) || !taggedTypes.has(String(v.type)) || typeof v.value !== 'string') return false;
  if (v.type === 'int64') return /^-?\d+$/.test(v.value);
  if (v.type === 'decimal') return /^[+-]?\d+(\.\d+)?$/.test(v.value);
  if (v.type === 'json') {
    try { JSON.parse(v.value); } catch { return false; }
  }
  return true;
}
export function parseSqlQueryResult(value: unknown): SqlQueryResult {
  if (!record(value) || value.status !== 'succeeded' || 'error' in value || value.isError === true
    || !nonempty(value.queryId) || !nonempty(value.bindingId) || !hash(value.sourceRevision)
    || !Array.isArray(value.columns) || !Array.isArray(value.rows)
    || !count(value.rowCount) || value.rowCount !== value.rows.length || !count(value.byteCount)
    || typeof value.truncated !== 'boolean' || typeof value.sampled !== 'boolean'
    || typeof value.elapsedMs !== 'number' || !Number.isFinite(value.elapsedMs) || value.elapsedMs < 0
    || (value.totalRowCount !== undefined && (!count(value.totalRowCount) || value.totalRowCount < value.rowCount))
    || (value.queryHash !== undefined && !hash(value.queryHash))
    || (value.artifactId !== undefined && !nonempty(value.artifactId))) return invalid('query result');
  for (const column of value.columns) {
    if (!record(column) || !nonempty(column.name) || !columnTypes.has(String(column.type))
      || !nonempty(column.sourceType) || !nullable(column)) return invalid('column');
  }
  const names = value.columns.map((c) => (c as Record<string, unknown>).name);
  if (new Set(names).size !== names.length) return invalid('column');
  const width = value.columns.length;
  if (value.rows.some((row) => !Array.isArray(row) || row.length !== width || !row.every(cell))) return invalid('row');
  return value as unknown as SqlQueryResult;
}

/** Authenticated SQL Sources and registered queries; never arbitrary SQL. */
export class SqlStudioClient {
  private readonly base: string;
  private readonly fetcher: typeof fetch;
  constructor(private readonly config: SqlStudioClientConfig) {
    const url = new URL(config.baseUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
      throw new Error('SQL Studio requires a credential-free HTTPS MCP host');
    }
    this.base = config.baseUrl.replace(/\/+$/, '');
    this.fetcher = config.fetcher ?? fetch;
  }
  private async request(path: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
    const response = await this.fetcher(`${this.base}/v1/sql${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${await this.config.getToken()}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error', signal,
    });
    let data: unknown;
    try { data = await response.json(); }
    catch { throw new SqlStudioError(`Invalid SQL API response (HTTP ${response.status})`, 'INVALID_RESPONSE', response.status); }
    if (!response.ok) {
      throw new SqlStudioError(record(data) && typeof data.message === 'string' ? data.message
        : record(data) && typeof data.error === 'string' ? data.error : `SQL request failed (${response.status})`,
      record(data) && typeof data.code === 'string' ? data.code : 'SQL_REQUEST_FAILED', response.status,
      record(data) && Array.isArray(data.details) ? data.details.filter((x): x is string => typeof x === 'string') : []);
    }
    return data;
  }
  async sources(tenantId: string, signal?: AbortSignal): Promise<SourceDescription[]> {
    const data = await this.request(`/sources?tenantId=${encodeURIComponent(tenantId)}`, undefined, signal);
    if (!record(data) || data.version !== 1 || !Array.isArray(data.sources)) return invalid('source list');
    return data.sources.map(parseSourceDescription);
  }
  async source(sourceId: string, tenantId: string, signal?: AbortSignal): Promise<SourceDescription> {
    const source = parseSourceDescription(await this.request(`/sources/${encodeURIComponent(sourceId)}?tenantId=${encodeURIComponent(tenantId)}`, undefined, signal));
    if (source.id !== sourceId) return invalid('source identity');
    return source;
  }
  async resolve(sourceId: string, tenantId: string, toolId?: string): Promise<SourceBinding> {
    const binding = parseSourceBinding(await this.request(`/sources/${encodeURIComponent(sourceId)}/resolve`, {
      tenantId, ...(toolId === undefined ? {} : { toolId }),
    }));
    if (binding.sourceId !== sourceId || (toolId !== undefined && binding.execution.toolId !== toolId)) return invalid('binding identity');
    return binding;
  }
  async query(request: SqlQueryRequest, signal?: AbortSignal): Promise<SqlQueryResult> {
    const result = parseSqlQueryResult(await this.request('/queries', request, signal));
    if (result.queryId !== request.queryId || result.bindingId !== request.binding.bindingId
      || result.sourceRevision !== request.binding.sourceRevision) return invalid('query identity');
    return result;
  }
}
