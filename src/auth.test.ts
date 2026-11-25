import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { exec, ChildProcess } from 'node:child_process';
import { NuBereaAuth } from './auth.js';
import { saveTokens, deleteTokens, loadTokens } from './storage.js';
import { NuBerea } from './client.js';

vi.mock('node:child_process', async (original) => ({
  ...await original<typeof import('node:child_process')>(), exec: vi.fn(),
}));
vi.mock('./storage.js', () => ({
  saveTokens: vi.fn(), deleteTokens: vi.fn(), loadTokens: vi.fn().mockResolvedValue(null),
  defaultTokenFile: () => '/unused-nuberea-test-tokens.json',
}));

const nativeFetch = globalThis.fetch;
const token = (expiresAt: number) => `header.${Buffer.from(JSON.stringify({ exp: expiresAt })).toString('base64url')}.signature`;

async function browserSignIn(expiry: () => number, beforeCallback?: (callback: URL) => Promise<void>) {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test callback port');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.mocked(exec).mockImplementation((command) => {
    const quotedUrl = command.match(/"([^"]+)"$/)?.[1];
    if (!quotedUrl) throw new Error('Missing browser sign-in URL');
    const loginUrl = new URL(quotedUrl);
    const callback = new URL(loginUrl.searchParams.get('return_to')!);
    callback.searchParams.set('firebase_token', token(expiry()));
    void Promise.resolve(beforeCallback?.(callback)).then(() => nativeFetch(callback)).then((response) => response.text());
    return new ChildProcess();
  });
  return new NuBereaAuth({ firebaseAuthPort: address.port });
}

afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

describe('chat Firebase credentials', () => {
  it('deduplicates concurrent refreshes and shares the cached API credential across chat, Study and MCP', async () => {
    vi.mocked(loadTokens).mockResolvedValueOnce({ accessToken: 'expired', refreshToken: 'old-refresh', expiresAt: 0 });
    const fetcher = vi.fn().mockImplementation(async (url, init) => {
      if (String(url).endsWith('/token')) return new Response(JSON.stringify({
        access_token: 'api-access', refresh_token: 'rotated', token_type: 'Bearer', expires_in: 900,
      }));
      expect(new Headers(init.headers).get('Authorization')).toBe('Bearer api-access');
      if (String(url).endsWith('/chat')) return new Response(
        'event: done\ndata: {"message":"Answer","responseID":"resp","isVerified":false}\n\n',
        { headers: { 'Content-Type': 'text/event-stream' } },
      );
      if (String(url).endsWith('/mcp')) return new Response(JSON.stringify({
        jsonrpc: '2.0', id: JSON.parse(init.body).id, result: {},
      }));
      return new Response(JSON.stringify({ language: 'grc', dictionary: 'ubs_greek', preferred: true,
        query: { by: 'lemma', value: 'λόγος' }, meanings: [], linkage_scope: 'lexical_meaning_not_token_sense', attribution: 'Source' }));
    });
    vi.stubGlobal('fetch', fetcher);
    const client = new NuBerea();
    await Promise.all([
      client.chat({ gptModel: '5.6 terra', userMessage: 'Hello!' }),
      client.mcpRequest('ping'),
      client.study.greekLexicon({ lemma: 'λόγος' }),
    ]);
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('/token'))).toHaveLength(1);
    expect(saveTokens).toHaveBeenCalledOnce();
    expect(exec).not.toHaveBeenCalled();
    expect(vi.mocked(loadTokens).mock.calls.at(-1)?.[2]).toBe('https://api.nuberea.com');
    expect(new URLSearchParams(fetcher.mock.calls[0][1].body).get('resource')).toBe('https://api.nuberea.com');
  });

  it('surfaces refresh failures without silently reopening browser sign-in', async () => {
    vi.mocked(loadTokens).mockResolvedValueOnce({ accessToken: 'expired', refreshToken: 'old', expiresAt: 0 });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      '{"error":"temporarily_unavailable","error_description":"Retry later"}', { status: 503 },
    )));
    await expect(new NuBereaAuth().getAccessToken()).rejects.toMatchObject({ status: 503, code: 'temporarily_unavailable' });
    expect(exec).not.toHaveBeenCalled();
    expect(saveTokens).not.toHaveBeenCalled();
  });

  it.each([
    { access_token: '', token_type: 'Bearer', expires_in: 900 },
    { access_token: 'new', token_type: 'Bearer', expires_in: 0 },
  ])('does not persist malformed successful refresh responses: %j', async (response) => {
    vi.mocked(loadTokens).mockResolvedValueOnce({ accessToken: 'expired', refreshToken: 'old', expiresAt: 0 });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(response))));
    await expect(new NuBereaAuth().getAccessToken()).rejects.toThrow('Invalid OAuth token response');
    expect(saveTokens).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
  });

  it('reloads a credential rotated by another SDK instance instead of reusing its stale refresh token', async () => {
    const start = Date.now();
    const old = { accessToken: 'old', refreshToken: 'old-refresh', expiresAt: start + 120000 };
    const latest = { accessToken: 'latest', refreshToken: 'latest-refresh', expiresAt: start + 1080000 };
    vi.mocked(loadTokens).mockResolvedValueOnce(old).mockResolvedValueOnce(old)
      .mockResolvedValueOnce(old).mockResolvedValueOnce(latest);
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      access_token: latest.accessToken, refresh_token: latest.refreshToken, token_type: 'Bearer', expires_in: 900,
    })));
    vi.stubGlobal('fetch', fetcher);
    const first = new NuBereaAuth(), second = new NuBereaAuth();
    expect(await first.getAccessToken()).toBe('old');
    expect(await second.getAccessToken()).toBe('old');
    vi.spyOn(Date, 'now').mockReturnValue(start + 180000);
    expect(await first.getAccessToken()).toBe('latest');
    expect(await second.getAccessToken()).toBe('latest');
    expect(fetcher).toHaveBeenCalledOnce();
    expect(saveTokens).toHaveBeenCalledOnce();
  });

  it('keeps anonymous discovery noninteractive but never hides an existing credential refresh outage', async () => {
    const fetcher = vi.fn().mockImplementation(async () => new Response('{"tools":[]}'));
    vi.stubGlobal('fetch', fetcher);
    expect(await new NuBerea().tools()).toEqual([]);
    expect(exec).not.toHaveBeenCalled();
    expect(new Headers(fetcher.mock.calls[0][1].headers).has('Authorization')).toBe(false);
    for (const invoke of [
      (client: NuBerea) => client.tools(),
      (client: NuBerea) => client.checkAuth(),
    ]) {
      vi.mocked(loadTokens).mockResolvedValueOnce({ accessToken: 'expired', refreshToken: 'old', expiresAt: 0 });
      fetcher.mockImplementationOnce(async () => new Response('{"error":"temporarily_unavailable","error_description":"Retry later"}', { status: 503 }));
      await expect(invoke(new NuBerea())).rejects.toMatchObject({ status: 503 });
    }
    expect(exec).not.toHaveBeenCalled();
  });

  it('uses an explicitly supplied Firebase session for OAuth bootstrap without opening another browser', async () => {
    const fetcher = vi.fn().mockImplementation(async (url, init) => {
      if (String(url).includes('/authorize')) {
        expect(new Headers(init.headers).get('Authorization')).toBe('Bearer existing-firebase-session');
        const request = new URL(String(url));
        expect(request.searchParams.get('resource')).toBe('https://api.nuberea.com');
        expect(request.searchParams.get('scope')).toBe('mcp chat study');
        return new Response(null, { status: 302, headers: {
          Location: `http://localhost:9876/callback?code=fixture&state=${request.searchParams.get('state')}`,
        } });
      }
      return new Response(JSON.stringify({
        access_token: 'api', refresh_token: 'refresh', token_type: 'Bearer', expires_in: 900,
      }));
    });
    vi.stubGlobal('fetch', fetcher);
    await new NuBerea({ getFirebaseIdToken: async () => 'existing-firebase-session' }).login();
    expect(exec).not.toHaveBeenCalled();
    expect(saveTokens).toHaveBeenCalledWith(
      { accessToken: 'api', refreshToken: 'refresh', expiresAt: expect.any(Number) },
      expect.any(String), 'https://auth.nuberea.com', 'https://api.nuberea.com',
    );
  });

  it('does not save a refresh that finishes after logout', async () => {
    vi.mocked(loadTokens).mockResolvedValueOnce({ accessToken: 'expired', refreshToken: 'old', expiresAt: 0 });
    let finish!: (response: Response) => void;
    const fetcher = vi.fn().mockImplementation(() => new Promise<Response>((resolve) => { finish = resolve; }));
    vi.stubGlobal('fetch', fetcher);
    const auth = new NuBereaAuth();
    const pending = auth.getAccessToken();
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    await auth.logout();
    const rejected = expect(pending).rejects.toThrow('logout');
    finish(new Response(JSON.stringify({ access_token: 'new', refresh_token: 'rotated', token_type: 'Bearer', expires_in: 900 })));
    await rejected;
    expect(saveTokens).not.toHaveBeenCalled();
  });

  it('does not attach a new session to a credential request still pending from before logout', async () => {
    vi.mocked(loadTokens).mockResolvedValueOnce({ accessToken: 'expired', refreshToken: 'old', expiresAt: 0 })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ accessToken: 'new-session', refreshToken: 'new-refresh', expiresAt: Date.now() + 900000 });
    let finish!: (response: Response) => void;
    const fetcher = vi.fn().mockImplementation(() => new Promise<Response>((resolve) => { finish = resolve; }));
    vi.stubGlobal('fetch', fetcher);
    const auth = new NuBereaAuth();
    const pending = auth.getAccessToken();
    const rejection = expect(pending).rejects.toThrow('logout');
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    await auth.logout();
    try {
      expect(await auth.getAccessToken()).toBe('new-session');
    } finally {
      finish(new Response(JSON.stringify({
        access_token: 'stale-session', refresh_token: 'stale-refresh', token_type: 'Bearer', expires_in: 900,
      })));
      await rejection;
    }
    expect(await auth.getAccessToken()).toBe('new-session');
    expect(saveTokens).not.toHaveBeenCalled();
  });

  it('cancels the pending browser listener on logout so a fresh sign-in can start on the same port', async () => {
    const auth = await browserSignIn(() => Math.floor(Date.now() / 1000) + 3600);
    const completeBrowser = vi.mocked(exec).getMockImplementation()!;
    const browserStarted = new Promise<void>((resolve) => {
      vi.mocked(exec).mockImplementation(() => {
        resolve();
        return new ChildProcess();
      });
    });
    const pending = auth.getFirebaseIdToken();
    await browserStarted;
    const rejection = expect(pending).rejects.toThrow('logout');
    await auth.logout();
    await rejection;
    vi.mocked(exec).mockImplementation(completeBrowser);
    await auth.getFirebaseIdToken();
    expect(exec).toHaveBeenCalledTimes(2);
    expect(saveTokens).not.toHaveBeenCalled();
  });

  it('rejects stale callback state without completing the active browser sign-in', async () => {
    const auth = await browserSignIn(() => Math.floor(Date.now() / 1000) + 3600, async (callback) => {
      const stale = new URL(callback);
      stale.searchParams.set('state', 'previous-session-state');
      const rejected = await nativeFetch(stale);
      expect(rejected.status).toBe(400);
      await rejected.text();
    });
    expect(await auth.getFirebaseIdToken()).toMatch(/^header\./);
    expect(exec).toHaveBeenCalledOnce();
  });

  it.each(['darwin', 'linux', 'win32'])('shares browser sign-in on %s and caches credentials without persisting them', async (platform) => {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: platform });
    try {
      const auth = await browserSignIn(() => Math.floor(Date.now() / 1000) + 3600);
      const [first, second] = await Promise.all([auth.getFirebaseIdToken(), auth.getFirebaseIdToken()]);
      expect(first).toBe(second);
      expect(await auth.getFirebaseIdToken()).toBe(first);
      expect(exec).toHaveBeenCalledOnce();
      expect(saveTokens).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, 'platform', descriptor);
    }
  });

  it('retains browser credentials through OAuth login but saves only OAuth tokens', async () => {
    const auth = await browserSignIn(() => Math.floor(Date.now() / 1000) + 3600);
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url) => String(url).includes('/authorize')
      ? new Response(null, { status: 302, headers: {
        Location: `http://localhost:9876/callback?code=fixture&state=${new URL(String(url)).searchParams.get('state')}`,
      } })
      : new Response(JSON.stringify({ access_token: 'oauth', refresh_token: 'refresh', token_type: 'Bearer', expires_in: 3600 }))));
    await auth.login();
    expect(await auth.getFirebaseIdToken()).toMatch(/^header\./);
    expect(exec).toHaveBeenCalledOnce();
    expect(saveTokens).toHaveBeenCalledWith({
      accessToken: 'oauth', refreshToken: 'refresh', expiresAt: expect.any(Number),
    }, expect.any(String), 'https://auth.nuberea.com', undefined);
    await auth.logout();
    expect(deleteTokens).toHaveBeenCalledOnce();
    await auth.getFirebaseIdToken();
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('prompts again near expiry and rejects expired browser credentials instead of caching them', async () => {
    const start = Date.now();
    const auth = await browserSignIn(() => Math.floor(Date.now() / 1000) + 3600);
    const first = await auth.getFirebaseIdToken();
    vi.spyOn(Date, 'now').mockReturnValue(start + 3550_000);
    expect(await auth.getFirebaseIdToken()).not.toBe(first);
    expect(exec).toHaveBeenCalledTimes(2);
    vi.restoreAllMocks();
    const expired = await browserSignIn(() => Math.floor(Date.now() / 1000) - 1);
    await expect(expired.getFirebaseIdToken()).rejects.toThrow('expired or invalid');
    expect(saveTokens).not.toHaveBeenCalled();
  });
});
