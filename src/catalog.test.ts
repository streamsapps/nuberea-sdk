import { afterEach, describe, expect, it, vi } from 'vitest';
import { CatalogClient } from './catalog.js';

afterEach(() => vi.unstubAllGlobals());
describe('tenant API coverage', () => {
  it('does not expose an HTML gateway response as the catalog error detail', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html><body>Gateway failure</body></html>', {
      status: 502, headers: { 'Content-Type': 'text/html' },
    })));
    const client = new CatalogClient({ baseUrl: 'https://mcp.nuberea.com', getToken: async () => 'oauth' });
    await expect(client.listTenants()).rejects.toMatchObject({
      status: 502, message: 'GET /v1/tenants failed (HTTP 502)',
    });
  });

  it('covers every tenant management route without live mutations', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url, init) => {
      const path = new URL(String(url)).pathname;
      calls.push(`${init.method} ${path}`);
      if (init.method === 'DELETE') return new Response(null, { status: 204 });
      if (init.method === 'GET' && path === '/v1/tenants') return new Response('{"tenants":[]}');
      if (init.method === 'GET' && path.endsWith('/connectors')) return new Response('{"connectors":[]}');
      if (init.method === 'GET' && path.endsWith('/tools')) return new Response('{"tools":[]}');
      return new Response('{}');
    }));
    const client = new CatalogClient({ baseUrl: 'https://mcp.nuberea.com', getToken: async () => 'oauth' });
    await client.listTenants(); await client.createTenant('Fixture');
    await client.getTenant('tenant'); await client.renameTenant('tenant', 'Renamed');
    await client.deleteTenant('tenant');
    await client.getAwsTrust('tenant'); await client.createAwsTrust('tenant');
    await client.setTrustRoleArn('tenant', 'arn:aws:iam::123456789012:role/fixture');
    await client.verifyAwsTrust('tenant'); await client.deleteAwsTrust('tenant');
    await client.getHfSetup('tenant'); await client.getHfIdentity('tenant');
    await client.setHfIdentity('tenant', 'fixture'); await client.verifyHfIdentity('tenant'); await client.deleteHfIdentity('tenant');
    const hf = { repo: 'owner/data', tableName: 'base', files: ['base.parquet'] };
    await client.listConnectors('tenant'); await client.createHfConnector('tenant', hf);
    await client.testConnector('tenant', { ...hf, kind: 'hf_dataset' });
    await client.updateHfConnector('tenant', 'connector', { revision: 'main' });
    await client.validateConnector('tenant', 'connector');
    await client.suggestTools('tenant', 'connector');
    await client.deleteConnector('tenant', 'connector');
    await client.listTools('tenant');
    await client.registerTool('tenant', { name: 'fixture', connectorId: 'connector', description: 'Fixture',
      inputSchema: { type: 'object', properties: {} }, sqlTemplate: 'SELECT 1', paramBindings: {}, rowLimit: 1 });
    await client.setToolStatus('tenant', 'fixture', true); await client.setToolStatus('tenant', 'fixture', false);
    await client.deleteTool('tenant', 'fixture');
    expect(new Set(calls).size).toBe(27);
    expect(calls).toContain('POST /v1/tenants/tenant/tools/fixture/enable');
    expect(calls).toContain('POST /v1/tenants/tenant/tools/fixture/disable');
    expect(calls).toContain('POST /v1/tenants/tenant/connectors/test');
    expect(calls.filter((call) => call.startsWith('DELETE '))).toHaveLength(5);
  });

  it('retains multi-relation HF payloads on create/test and newer update fields without changing tenant scope', async () => {
    const fetcher = vi.fn().mockImplementation(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetcher);
    const client = new CatalogClient({ baseUrl: 'https://mcp.nuberea.com', getToken: async () => 'oauth' });
    const params = { repo: 'owner/data', tableName: 'base', files: ['base.parquet'],
      relations: [{ name: 'related', files: ['related.parquet'] }] };
    await client.createHfConnector('tenant', params);
    await client.testConnector('tenant', { ...params, kind: 'hf_dataset' });
    await client.updateHfConnector('tenant', 'connector', { hfResource: 'owner', files: ['new.parquet'] });
    expect(JSON.parse(fetcher.mock.calls[0][1].body).relations).toEqual(params.relations);
    expect(JSON.parse(fetcher.mock.calls[1][1].body).relations).toEqual(params.relations);
    expect(JSON.parse(fetcher.mock.calls[2][1].body).hfResource).toBe('owner');
    for (const [url, init] of fetcher.mock.calls) {
      expect(String(url)).toContain('/v1/tenants/tenant/');
      expect(new Headers(init.headers).get('Authorization')).toBe('Bearer oauth');
      expect(init.redirect).toBe('error');
    }
  });
  it('treats only missing trust as null, propagates access/service failures and keeps verification failure details', async () => {
    const fetcher = vi.fn().mockImplementation(async () => new Response('{"code":"NOT_FOUND","message":"No trust"}', { status: 404 }));
    vi.stubGlobal('fetch', fetcher);
    const client = new CatalogClient({ baseUrl: 'https://mcp.nuberea.com', getToken: async () => 'oauth' });
    expect(await client.getAwsTrust('tenant')).toBeNull();
    for (const status of [403, 503]) {
      fetcher.mockImplementationOnce(async () => new Response('{"message":"Denied","code":"DENIED"}', { status }));
      await expect(client.getAwsTrust('tenant')).rejects.toMatchObject({ status, code: 'DENIED' });
    }
    fetcher.mockImplementationOnce(async () => new Response('{"status":"error","reason":"Trust failed"}', { status: 422 }));
    await expect(client.verifyAwsTrust('tenant')).rejects.toMatchObject({
      status: 422, details: { status: 'error', reason: 'Trust failed' },
    });
  });
});
