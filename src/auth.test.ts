import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { exec, ChildProcess } from 'node:child_process';
import { NuBereaAuth } from './auth.js';
import { saveTokens, deleteTokens } from './storage.js';

vi.mock('node:child_process', async (original) => ({
  ...await original<typeof import('node:child_process')>(), exec: vi.fn(),
}));
vi.mock('./storage.js', () => ({
  saveTokens: vi.fn(), deleteTokens: vi.fn(), loadTokens: vi.fn().mockResolvedValue(null),
  defaultTokenFile: () => '/unused-nuberea-test-tokens.json',
}));

const nativeFetch = globalThis.fetch;
const token = (expiresAt: number) => `header.${Buffer.from(JSON.stringify({ exp: expiresAt })).toString('base64url')}.signature`;

async function browserSignIn(expiry: () => number) {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test callback port');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.mocked(exec).mockImplementation((command) => {
    const loginUrl = new URL(command.slice('open "'.length, -1));
    const callback = new URL(loginUrl.searchParams.get('return_to')!);
    callback.searchParams.set('firebase_token', token(expiry()));
    void nativeFetch(callback).then((response) => response.text());
    return new ChildProcess();
  });
  return new NuBereaAuth({ firebaseAuthPort: address.port });
}

afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

describe('chat Firebase credentials', () => {
  it('shares concurrent browser sign-in and caches Firebase credentials without persisting them', async () => {
    const auth = await browserSignIn(() => Math.floor(Date.now() / 1000) + 3600);
    const [first, second] = await Promise.all([auth.getFirebaseIdToken(), auth.getFirebaseIdToken()]);
    expect(first).toBe(second);
    expect(await auth.getFirebaseIdToken()).toBe(first);
    expect(exec).toHaveBeenCalledOnce();
    expect(saveTokens).not.toHaveBeenCalled();
  });

  it('retains browser credentials through OAuth login but saves only OAuth tokens', async () => {
    const auth = await browserSignIn(() => Math.floor(Date.now() / 1000) + 3600);
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url) => String(url).includes('/authorize')
      ? new Response(null, { status: 302, headers: { Location: 'http://localhost:9876/callback?code=fixture' } })
      : new Response(JSON.stringify({ access_token: 'oauth', refresh_token: 'refresh', expires_in: 3600 }))));
    await auth.login();
    expect(await auth.getFirebaseIdToken()).toMatch(/^header\./);
    expect(exec).toHaveBeenCalledOnce();
    expect(saveTokens).toHaveBeenCalledWith({
      accessToken: 'oauth', refreshToken: 'refresh', expiresAt: expect.any(Number),
    }, expect.any(String), 'https://auth.nuberea.com');
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
