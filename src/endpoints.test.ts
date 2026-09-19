import { afterEach, describe, expect, it, vi } from 'vitest';
import { MCP_ENDPOINTS, resolveMcpUrl } from './auth.js';
import { NuBerea } from './client.js';

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
});

describe('NuBerea MCP requests', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends MCP tool calls to the preproduction MCP host by default', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
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
      MCP_ENDPOINTS.preproduction,
      expect.objectContaining({ method: 'POST' }),
    );
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
});
