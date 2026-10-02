import { describe, it, expect, vi, afterEach } from 'vitest';
import { NuBerea } from './client.js';
import {
  SqlStudioClient, SqlStudioError, parseSourceBinding, parseSourceDescription, parseSqlQueryResult,
  type SourceDescription, type SourceBinding, type SqlQueryResult, type SqlQueryRequest,
} from './sqlStudio.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const connectorId = '22222222-2222-4222-8222-222222222222';
const toolId = '33333333-3333-4333-8333-333333333333';
const sourceId = `catalog:${tenantId}:${connectorId}`;
const hash = 'a'.repeat(64);
const source: SourceDescription = {
  id: sourceId, name: 'owner/data', group: 'hugging-face', status: 'available',
  dialect: 'duckdb', revision: hash, schemaRevision: hash,
  tables: [{ name: 'data', columns: [{ name: 'id', type: 'BIGINT', nullable: false }] }],
  capabilities: {
    readonlyExecution: true, localPreview: false, sameEngineJoins: false,
    maxRows: 20, maxBytes: 100000, maxTimeoutMs: 30000, registeredQueriesOnly: true,
    immutableSnapshot: false, cancellation: false, offset: false, idempotency: false,
  },
  registeredQueries: [{
    toolId, name: 'list_data', description: 'List', sql: 'SELECT id FROM data LIMIT :limit',
    inputSchema: { type: 'object', properties: { limit: { type: 'integer' } } },
    parameters: { limit: { sqlParam: 'limit', type: 'integer', max: 20 } }, rowLimit: 20,
  }],
};
const binding: SourceBinding = {
  sourceId, bindingId: 'sqlb_test', sourceRevision: hash, schemaRevision: hash, dialect: 'duckdb',
  expiresAt: '2026-10-02T01:00:00.000Z',
  execution: { kind: 'registered-tool', toolId, toolName: 'list_data', templateHash: hash },
};
const result: SqlQueryResult = {
  queryId: 'q1', status: 'succeeded', columns: [{ name: 'id', type: 'integer', sourceType: 'BIGINT' }],
  rows: [[{ type: 'int64', value: '9223372036854775807' }]], rowCount: 1,
  byteCount: 100, truncated: false, sampled: false, elapsedMs: 20, bindingId: binding.bindingId, sourceRevision: hash,
};
const query: SqlQueryRequest = {
  queryId: 'q1', binding, sql: source.registeredQueries[0].sql, parameters: { limit: 10 }, rowLimit: 10, mode: 'remote',
};
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json' },
});

describe('public SQL Studio client', () => {
  afterEach(() => vi.restoreAllMocks());
  it('lists sources, loads a descriptor, resolves approved tools, and submits the typed remote query', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response({ version: 1, sources: [source] }))
      .mockResolvedValueOnce(response(source)).mockResolvedValueOnce(response(binding)).mockResolvedValueOnce(response(result));
    const getToken = vi.fn().mockResolvedValue('existing-oauth-token');
    const client = new SqlStudioClient({ baseUrl: 'https://mcp.example.test/', getToken, fetcher });
    expect(await client.sources(tenantId)).toEqual([source]);
    expect(await client.source(sourceId, tenantId)).toEqual(source);
    expect(await client.resolve(sourceId, tenantId, toolId)).toEqual(binding);
    expect(await client.query(query)).toEqual(result);
    expect(fetcher.mock.calls.map((c) => c[0])).toEqual([
      `https://mcp.example.test/v1/sql/sources?tenantId=${tenantId}`,
      `https://mcp.example.test/v1/sql/sources/${encodeURIComponent(sourceId)}?tenantId=${tenantId}`,
      `https://mcp.example.test/v1/sql/sources/${encodeURIComponent(sourceId)}/resolve`,
      'https://mcp.example.test/v1/sql/queries',
    ]);
    expect(fetcher.mock.calls[2][1]).toMatchObject({
      method: 'POST', redirect: 'error',
      headers: { Authorization: 'Bearer existing-oauth-token' }, body: JSON.stringify({ tenantId, toolId }),
    });
    expect(getToken).toHaveBeenCalledTimes(4);
  });
  it('preserves HTTP denial, stale reference and execution error details', async () => {
    const client = new SqlStudioClient({
      baseUrl: 'https://mcp.example.test', getToken: async () => 'token',
      fetcher: vi.fn().mockResolvedValue(response({ code: 'STALE_BINDING', message: 'Resolve again', details: ['configuration changed'] }, 409)),
    });
    await expect(client.query(query)).rejects.toMatchObject({
      name: 'SqlStudioError', status: 409, code: 'STALE_BINDING', message: 'Resolve again', details: ['configuration changed'],
    });
  });
  it('fails closed on non-JSON, error-shaped, malformed and mismatched successes', async () => {
    for (const data of [
      {}, { ...result, status: 'failed' }, { ...result, isError: true },
      { ...result, rowCount: 0 }, { ...result, rows: [[Number('9223372036854775807')]] },
      { ...result, rows: [[]] }, { ...result, queryId: 'other' },
      { ...result, bindingId: 'other' }, { ...result, sourceRevision: 'b'.repeat(64) },
    ]) {
      const client = new SqlStudioClient({
        baseUrl: 'https://mcp.example.test', getToken: async () => 'token', fetcher: vi.fn().mockResolvedValue(response(data)),
      });
      await expect(client.query(query)).rejects.toBeInstanceOf(SqlStudioError);
    }
    const client = new SqlStudioClient({
      baseUrl: 'https://mcp.example.test', getToken: async () => 'token',
      fetcher: vi.fn().mockResolvedValue(new Response('not json', { status: 200 })),
    });
    await expect(client.sources(tenantId)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
  it('rejects another source or tool returned for a resolution', async () => {
    const client = new SqlStudioClient({
      baseUrl: 'https://mcp.example.test', getToken: async () => 'token',
      fetcher: vi.fn().mockResolvedValue(response({ ...binding, execution: { ...binding.execution, toolId: 'other' } })),
    });
    await expect(client.resolve(sourceId, tenantId, toolId)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
  it('rejects unsafe API origins and bearer-token redirects', () => {
    for (const baseUrl of ['http://evil.test', 'https://user:pass@evil.test', 'https://evil.test?token=x']) {
      expect(() => new SqlStudioClient({ baseUrl, getToken: async () => 'token' })).toThrow('credential-free HTTPS');
    }
  });
  it('NuBerea exposes SQL Studio on the MCP host without altering local legacy clients', async () => {
    const fetcher = vi.fn().mockResolvedValue(response({ version: 1, sources: [] }));
    vi.stubGlobal('fetch', fetcher);
    try {
      const client = new NuBerea({ accessToken: 'token' });
      expect(await client.sqlStudio.sources(tenantId)).toEqual([]);
      expect(fetcher.mock.calls[0][0]).toBe(`https://mcp.nubereappe.com/v1/sql/sources?tenantId=${tenantId}`);
      expect(() => new NuBerea({ baseUrl: 'http://localhost:3000', accessToken: 'token' })).not.toThrow();
    } finally { vi.unstubAllGlobals(); }
  });
});

describe('SQL response parsers', () => {
  it('keeps declared empty result columns and does not invent a total', () => {
    const empty = parseSqlQueryResult({ ...result, rows: [], rowCount: 0 });
    expect(empty.columns).toEqual(result.columns); expect(empty.rows).toEqual([]);
    expect(empty).not.toHaveProperty('totalRowCount');
  });
  it('validates typed decimal, time and JSON cells without loss', () => {
    const parsed = parseSqlQueryResult({
      ...result, columns: [
        { name: 'amount', type: 'decimal', sourceType: 'DECIMAL(38,4)' },
        { name: 'time', type: 'time', sourceType: 'TIME' },
        { name: 'payload', type: 'json', sourceType: 'JSON' },
      ], rows: [[
        { type: 'decimal', value: '1234567890123456789.1234' },
        { type: 'time', value: '10:20:30.123456' }, { type: 'json', value: '{"id":"9223372036854775807"}' },
      ]],
    });
    expect(parsed.rows[0][0]).toEqual({ type: 'decimal', value: '1234567890123456789.1234' });
    expect(() => parseSqlQueryResult({ ...result, rows: [[{ type: 'json', value: 'not-json' }]] })).toThrow();
  });
  it('rejects fake capabilities and malformed registry metadata', () => {
    expect(parseSourceDescription(source)).toEqual(source);
    expect(parseSourceBinding(binding)).toEqual(binding);
    expect(() => parseSourceDescription({ ...source, capabilities: { ...source.capabilities, immutableSnapshot: true } })).toThrow();
    expect(() => parseSourceDescription({ ...source, tables: [{ name: 'data', columns: [{}] }] })).toThrow();
    expect(() => parseSourceBinding({ ...binding, execution: { kind: 'sql' } })).toThrow();
  });
});

describe('legacy analytics query failures', () => {
  it('never fabricates successful empty rows for MCP or malformed text errors', async () => {
    const client = new NuBerea({ accessToken: 'token' });
    const tool = vi.spyOn(client, 'tool');
    tool.mockResolvedValueOnce({ content: [{ type: 'text', text: 'Permission denied' }], isError: true });
    await expect(client.query('SELECT 1')).rejects.toThrow('execution failed');
    tool.mockResolvedValueOnce({ content: [{ type: 'text', text: 'Permission denied' }] });
    await expect(client.query('SELECT 1')).rejects.toThrow('no structured rows');
    tool.mockResolvedValueOnce({ content: [{ type: 'text', text: 'Error details []' }] });
    await expect(client.query('SELECT 1')).rejects.toThrow('invalid success summary');
    tool.mockResolvedValueOnce({ content: [{ type: 'text', text: '0 rows returned in 1ms\n\n[]' }] });
    expect(await client.query('SELECT 1')).toMatchObject({ rows: [], rowCount: 0 });
  });
  it('preserves a declared empty schema and rejects malformed structured successes', async () => {
    const client = new NuBerea({ accessToken: 'token' }); const tool = vi.spyOn(client, 'tool');
    tool.mockResolvedValueOnce({ content: [], structuredContent: {
      columns: ['id'], rows: [], rowCount: 0, executionTimeMs: 1.5, truncated: false,
    } });
    expect(await client.query('SELECT 1')).toMatchObject({ columns: ['id'], rows: [], executionTimeMs: 1.5 });
    tool.mockResolvedValueOnce({ content: [], structuredContent: { error: 'denied' } });
    await expect(client.query('SELECT 1')).rejects.toThrow('execution failed');
    tool.mockResolvedValueOnce({ content: [], structuredContent: { columns: ['id'], rows: [], rowCount: 3 } });
    await expect(client.query('SELECT 1')).rejects.toThrow('invalid structured');
  });
  it('rejects unsupported offsets and options before executing', async () => {
    const client = new NuBerea({ accessToken: 'token' }); const tool = vi.spyOn(client, 'tool');
    await expect(client.query('SELECT 1', { offset: 10 })).rejects.toThrow('not supported');
    await expect(client.query('SELECT 1', { timeout: 1000 })).rejects.toThrow('not supported');
    expect(tool).not.toHaveBeenCalled();
  });
});
