import { afterEach, describe, expect, it, vi } from 'vitest';
import { OAuthClient, type AuthorizeRequest } from './oauth.js';

const config = { baseUrl: 'https://auth.nuberea.com',
  getAccessToken: vi.fn().mockResolvedValue('oauth'), getFirebaseIdToken: vi.fn().mockResolvedValue('firebase') };
const request: AuthorizeRequest = {
  response_type: 'code', client_id: 'client', redirect_uri: 'http://localhost:9876/callback',
  code_challenge: 'x'.repeat(43), code_challenge_method: 'S256', state: 'state', resource: 'https://mcp.nuberea.com/mcp',
};
afterEach(() => { vi.clearAllMocks(); });
describe('standard OAuth SDK', () => {
  it('omits an explicitly undefined optional scope instead of requesting the literal scope undefined', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: {
      Location: 'http://localhost:9876/callback?code=code&state=state',
    } }));
    await new OAuthClient(config, fetcher).authorize({ ...request, scope: undefined });
    expect(new URL(fetcher.mock.calls[0][0]).searchParams.has('scope')).toBe(false);
  });

  it('authorizes with Firebase, does not follow redirects and validates state, issuer and redirect target', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: {
      Location: 'http://localhost:9876/callback?code=code&state=state&iss=https%3A%2F%2Fauth.nuberea.com',
    } }));
    expect(await new OAuthClient(config, fetcher).authorize(request)).toEqual({
      code: 'code', state: 'state', issuer: 'https://auth.nuberea.com',
    });
    expect(new Headers(fetcher.mock.calls[0][1].headers).get('Authorization')).toBe('Bearer firebase');
    expect(fetcher.mock.calls[0][1].redirect).toBe('manual');
    expect(config.getAccessToken).not.toHaveBeenCalled();
    for (const location of [
      'https://other.example/callback?code=code&state=state',
      'http://localhost:9876/callback?code=code&state=wrong',
      'http://localhost:9876/callback?code=code&state=state&iss=https%3A%2F%2Fother.example',
    ]) {
      await expect(new OAuthClient(config, async () => new Response(null, { status: 302, headers: { Location: location } }))
        .authorize(request)).rejects.toThrow(/invalid|unexpected/);
    }
  });

  it('form-encodes both supported grants without bearer credentials or automatic retries', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      access_token: 'access', token_type: 'Bearer', expires_in: 900, refresh_token: 'refresh',
    })));
    const client = new OAuthClient(config, fetcher);
    await client.token({ grant_type: 'authorization_code', code: 'code', code_verifier: 'v'.repeat(43),
      client_id: 'client', redirect_uri: request.redirect_uri, resource: request.resource });
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'Expired' }), { status: 400 }));
    await expect(client.token({ grant_type: 'refresh_token', refresh_token: 'refresh',
      client_id: 'client', resource: request.resource })).rejects.toMatchObject({ code: 'invalid_grant', status: 400 });
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const [, init] of fetcher.mock.calls) {
      expect(new Headers(init.headers).get('Authorization')).toBeNull();
      expect(new Headers(init.headers).get('Content-Type')).toBe('application/x-www-form-urlencoded');
      expect(new URLSearchParams(init.body).get('resource')).toBe(request.resource);
      expect(init.redirect).toBe('error');
    }
    expect(config.getAccessToken).not.toHaveBeenCalled();
    expect(config.getFirebaseIdToken).not.toHaveBeenCalled();
  });

  it('keeps discovery public, userinfo OAuth-authenticated and registration explicitly caller-controlled', async () => {
    const metadata = { issuer: config.baseUrl, authorization_endpoint: config.baseUrl + '/authorize',
      token_endpoint: config.baseUrl + '/token', jwks_uri: config.baseUrl + '/.well-known/jwks.json' };
    const fetcher = vi.fn().mockImplementation(async (url, init) => {
      if (String(url).endsWith('/userinfo')) return new Response(JSON.stringify({ sub: 'subject' }));
      if (String(url).endsWith('jwks.json')) return new Response('{"keys":[]}');
      if (String(url).includes('oauth-protected-resource')) return new Response(JSON.stringify({
        resource: request.resource, authorization_servers: [config.baseUrl],
      }));
      if (String(url).endsWith('/register')) return new Response(JSON.stringify({
        ...JSON.parse(init.body), client_id: 'registered', client_id_issued_at: 1,
        grant_types: ['authorization_code'], response_types: ['code'], token_endpoint_auth_method: 'none',
        registration_client_uri: config.baseUrl + '/register/registered', registration_access_token: 'registration',
      }), { status: 201 });
      return new Response(JSON.stringify(metadata));
    });
    const client = new OAuthClient(config, fetcher);
    await client.metadata('openid'); await client.metadata(); await client.jwks();
    await client.protectedResource(); await client.protectedResource(false);
    for (const [, init] of fetcher.mock.calls) expect(new Headers(init.headers).get('Authorization')).toBeNull();
    await client.register({ redirect_uris: [request.redirect_uri] });
    expect(new Headers(fetcher.mock.calls.at(-1)[1].headers).get('Authorization')).toBeNull();
    await client.userinfo(); await client.userinfo({ method: 'POST' });
    expect(new Headers(fetcher.mock.calls.at(-1)[1].headers).get('Authorization')).toBe('Bearer oauth');
    expect(config.getAccessToken).toHaveBeenCalledTimes(2);
  });
});
