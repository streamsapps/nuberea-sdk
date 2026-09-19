import { afterEach, describe, expect, it, vi } from 'vitest';
import { MCP_ENDPOINTS, resolveMcpUrl } from './auth.js';
import { NuBerea } from './client.js';
import { defaultTokenFile, tokenStoreAccount } from './storage.js';

describe('MCP endpoint resolution', () => {
  it.each([
    ['https://auth.nubereappe.com', MCP_ENDPOINTS.preproduction],
    ['https://api.nubereappe.com', MCP_ENDPOINTS.preproduction],
    ['https://auth.nuberea.com', MCP_ENDPOINTS.production],
    ['https://api.nuberea.com', MCP_ENDPOINTS.production],
    ['http://localhost:3000/', 'http://localhost:3000/mcp'],
  ])('maps %s to %s', (oauthBaseUrl, expected) => {
    expect(resolveMcpUrl(oauthBaseUrl)).toBe(expected);
  });

  it('isolates persisted credentials by OAuth host', () => {
    expect(defaultTokenFile('https://auth.nuberea.com')).not.toBe(
      defaultTokenFile('https://auth.nubereappe.com'),
    );
    expect(tokenStoreAccount('https://auth.nuberea.com')).toBe('tokens:auth.nuberea.com');
    expect(tokenStoreAccount('https://auth.nubereappe.com')).toBe('tokens:auth.nubereappe.com');
  });
});

describe('NuBerea MCP requests', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('sends MCP tool calls to the production MCP host by default', async () => {
    const fetchMock = vi.fn().mockImplementation(async () =>
      new Response(JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: { content: [] },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = new NuBerea({ accessToken: 'token' });
    await client.tool('example');

    expect(fetchMock).toHaveBeenCalledWith(
      MCP_ENDPOINTS.production,
      expect.objectContaining({ method: 'POST' }),
    );
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(request.headers).not.toHaveProperty('mcp-session-id');
  });

  it('does not retain a session ID returned by an MCP server', async () => {
    const fetchMock = vi.fn().mockImplementation(async () =>
      new Response(JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: { content: [] },
      }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'mcp-session-id': 'obsolete-session',
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = new NuBerea({ accessToken: 'token' });
    await client.tool('first');
    await client.tool('second');
    await client.close();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondRequest = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect(secondRequest.headers).not.toHaveProperty('mcp-session-id');
  });

  it('loads the stateless tool list from the production MCP host', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ tools: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = new NuBerea({
      baseUrl: 'https://api.nuberea.com',
      accessToken: 'token',
    });
    await client.tools();

    expect(fetchMock).toHaveBeenCalledWith(
      'https://mcp.nuberea.com/tools',
      expect.any(Object),
    );
  });

  it('sends catalog requests to the MCP host', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ tenants: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = new NuBerea({ accessToken: 'token' });
    await client.catalog.listTenants();

    expect(fetchMock).toHaveBeenCalledWith(
      'https://mcp.nuberea.com/v1/tenants',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('honors environment URL overrides for programmatic clients', async () => {
    vi.stubEnv('NUBEREA_BASE_URL', 'https://auth.nubereappe.com');
    vi.stubEnv('NUBEREA_MCP_URL', 'https://mcp.nubereappe.com/mcp');
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ tenants: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = new NuBerea({ accessToken: 'token' });
    await client.catalog.listTenants();

    expect(fetchMock).toHaveBeenCalledWith(
      'https://mcp.nubereappe.com/v1/tenants',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('surfaces catalog error details from the server', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        code: 'ACCOUNT_ACCESS_DENIED',
        message: 'The account cannot access this tenant.',
      }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      }),
    ));

    const client = new NuBerea({ accessToken: 'token' });

    await expect(client.catalog.listTenants()).rejects.toThrow(
      'GET /v1/tenants failed (HTTP 403): ACCOUNT_ACCESS_DENIED: The account cannot access this tenant.',
    );
  });
});
