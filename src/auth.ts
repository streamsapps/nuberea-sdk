/**
 * NuBerea Auth — OAuth 2.1 + PKCE authentication flow.
 *
 * Handles:
 *   1. Firebase sign-in (browser-based or token-based)
 *   2. OAuth 2.1 authorization code + PKCE exchange
 *   3. Token persistence and refresh
 */

import { exec } from 'node:child_process';
import crypto from 'node:crypto';
import http from 'node:http';
import { ApiError } from './http.js';
import { OAuthClient, type OAuthTokenResponse } from './oauth.js';
import {
  type PersistedTokens,
  defaultTokenFile,
  deleteTokens,
  loadTokens,
  saveTokens,
} from './storage.js';

export interface AuthConfig {
  /** OAuth server base URL */
  oauthBaseUrl: string;
  /** MCP endpoint URL (used as `resource` in OAuth) */
  mcpUrl: string;
  /** OAuth client_id */
  clientId: string;
  /** Local port for OAuth redirect callback */
  callbackPort: number;
  /** Local port for Firebase sign-in callback */
  firebaseAuthPort: number;
  /** Path to store tokens on disk */
  tokenFile: string;
  /** Login page URL for browser-based sign-in */
  loginUrl: string;
  /** Requested scopes; NuBerea defaults to mcp/chat/study, direct auth clients to mcp. */
  scopes?: string[];
  /** OAuth resource binding. Omitted preserves the legacy MCP-only resource. */
  resource?: string;
  /** Existing Firebase session used only to bootstrap OAuth; never persisted. */
  firebaseTokenProvider?: () => Promise<string | undefined>;
}

/** Tokens kept in memory and persisted to keychain/file (no login credentials). */
export type StoredTokens = PersistedTokens;

export const MCP_ENDPOINTS = {
  development: 'https://mcp.nubereappe.com/mcp',
  preproduction: 'https://mcp.nubereappe.com/mcp',
  production: 'https://mcp.nuberea.com/mcp',
} as const;

export function resolveApiResource(oauthBaseUrl: string): string | undefined {
  const host = new URL(oauthBaseUrl).hostname;
  if (host === 'auth.nuberea.com' || host === 'api.nuberea.com') return 'https://api.nuberea.com';
  if (host === 'auth.nubereappe.com' || host === 'api.nubereappe.com') return 'https://api.nubereappe.com';
  return undefined;
}

/**
 * Resolve the MCP transport independently from the OAuth/control-plane host.
 * Unknown hosts retain the legacy same-origin behavior for self-hosted setups.
 */
export function resolveMcpUrl(oauthBaseUrl: string): string {
  const baseUrl = oauthBaseUrl.replace(/\/+$/, '');

  try {
    const { hostname } = new URL(baseUrl);
    if (
      hostname === 'auth.nubereappe.com'
      || hostname === 'api.nubereappe.com'
    ) {
      return MCP_ENDPOINTS.preproduction;
    }
    if (hostname === 'auth.nuberea.com' || hostname === 'api.nuberea.com') {
      return MCP_ENDPOINTS.production;
    }
  } catch {
    // Preserve the previous same-origin fallback for non-standard base URLs.
  }

  return `${baseUrl}/mcp`;
}

const DEFAULT_CONFIG: AuthConfig = {
  oauthBaseUrl: 'https://auth.nuberea.com',
  mcpUrl: MCP_ENDPOINTS.production,
  clientId: 'mcp-client-test',
  callbackPort: 9876,
  firebaseAuthPort: 9875,
  tokenFile: defaultTokenFile(),
  loginUrl: 'https://nuberea.com/login',
  scopes: ['mcp'],
};

export class NuBereaAuth {
  private config: AuthConfig;
  private tokens: StoredTokens | null = null;
  private firebaseCredential: { token: string; expiresAt: number } | null = null;
  private firebaseSignIn: Promise<string> | undefined;
  private cancelFirebaseSignIn: (() => Promise<void>) | undefined;
  private firebaseGeneration = 0;
  private accessRequest: { generation: number; promise: Promise<string> } | undefined;
  private loginRequest: { generation: number; promise: Promise<StoredTokens> } | undefined;
  private refreshRequest: { generation: number; promise: Promise<StoredTokens> } | undefined;
  private persistence: Promise<void> = Promise.resolve();
  private readonly storageResource: string | undefined;

  constructor(config?: Partial<AuthConfig>) {
    const oauthBaseUrl =
      config?.oauthBaseUrl
      ?? process.env.NUBEREA_BASE_URL
      ?? DEFAULT_CONFIG.oauthBaseUrl;
    const mcpUrl =
      config?.mcpUrl
      ?? process.env.NUBEREA_MCP_URL
      ?? resolveMcpUrl(oauthBaseUrl);
    this.storageResource = config?.resource && config.resource !== mcpUrl ? config.resource : undefined;
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
      oauthBaseUrl,
      mcpUrl,
      tokenFile: config?.tokenFile ?? defaultTokenFile(oauthBaseUrl, this.storageResource),
    };
  }

  // ==========================================================================
  // Public API
  // ==========================================================================

  /**
   * Get a valid access token, refreshing or re-authenticating as needed.
   */
  async getAccessToken(): Promise<string> {
    const generation = this.firebaseGeneration;
    if (this.accessRequest?.generation === generation) return this.accessRequest.promise;
    const promise = this.acquireAccessToken().finally(() => {
      if (this.accessRequest?.promise === promise) this.accessRequest = undefined;
    });
    this.accessRequest = { generation, promise };
    return promise;
  }

  private async acquireAccessToken(): Promise<string> {
    await this.loadStoredCredentials();

    // Still valid?
    if (this.tokens && this.tokens.expiresAt > Date.now() + 60_000) {
      return this.tokens.accessToken;
    }

    // Try refresh
    if (this.tokens?.refreshToken) {
      return (await this.refresh()).accessToken;
    }

    // Full login flow
    return (await this.login()).accessToken;
  }

  private async loadStoredCredentials(): Promise<void> {
    if (this.tokens) return;
    const generation = this.firebaseGeneration;
    const stored = await loadTokens(this.config.tokenFile, this.config.oauthBaseUrl, this.storageResource);
    this.assertGeneration(generation);
    this.tokens ??= stored;
  }

  /** Refresh existing credentials if needed, but never start interactive sign-in. */
  async getAccessTokenIfAvailable(): Promise<string | undefined> {
    await this.loadStoredCredentials();
    return this.tokens ? this.getAccessToken() : undefined;
  }

  /**
   * Run the full interactive login flow (opens browser).
   * The Firebase credential is used only locally — it is never persisted.
   */
  async login(): Promise<StoredTokens> {
    const generation = this.firebaseGeneration;
    if (this.loginRequest?.generation === generation) return this.loginRequest.promise;
    const promise = this.loginImpl().finally(() => {
      if (this.loginRequest?.promise === promise) this.loginRequest = undefined;
    });
    this.loginRequest = { generation, promise };
    return promise;
  }

  private async loginImpl(): Promise<StoredTokens> {
    const generation = this.firebaseGeneration;
    const fbToken = await this.getFirebaseIdToken();
    const { verifier, challenge } = createPkce();
    const code = await this.fetchAuthCode(fbToken, challenge);
    const tokenResponse = await this.exchangeCode(code, verifier);
    if (!tokenResponse.refresh_token) throw new ApiError('OAuth login did not return a refresh token', 'INVALID_API_RESPONSE');
    const tokens = {
      accessToken: tokenResponse.access_token,
      refreshToken: tokenResponse.refresh_token,
      expiresAt: Date.now() + tokenResponse.expires_in * 1000,
    };

    await this.persist(tokens, generation);
    return tokens;
  }

  private assertGeneration(generation: number): void {
    if (generation !== this.firebaseGeneration) throw new Error('Credential request was cancelled by logout. Sign in again.');
  }

  private async persist(tokens: StoredTokens, generation: number): Promise<void> {
    const write = Promise.allSettled([this.persistence]).then(async () => {
      this.assertGeneration(generation);
      await saveTokens(tokens, this.config.tokenFile, this.config.oauthBaseUrl, this.storageResource);
      this.assertGeneration(generation);
      this.tokens = tokens;
    });
    this.persistence = write;
    return write;
  }

  /** Firebase credential for initial consent or an explicit compatibility override. Never persisted. */
  async getFirebaseIdToken(): Promise<string> {
    const generation = this.firebaseGeneration;
    const provided = await this.config.firebaseTokenProvider?.();
    this.assertGeneration(generation);
    if (provided !== undefined) {
      if (!provided) throw new ApiError('The Firebase token provider returned an empty credential', 'AUTH_REQUIRED');
      return provided;
    }
    if (this.firebaseCredential && this.firebaseCredential.expiresAt > Date.now() + 60_000) {
      return this.firebaseCredential.token;
    }
    return this.firebaseSignIn ??= this.signInFirebase().finally(() => { this.firebaseSignIn = undefined; });
  }

  private async signInFirebase(): Promise<string> {
    const generation = this.firebaseGeneration;
    const token = await this.fetchFirebaseToken();
    if (generation !== this.firebaseGeneration) {
      throw new Error('Firebase sign-in was cancelled by logout. Sign in again.');
    }
    let payload: unknown;
    try {
      payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'));
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      throw new Error('Firebase sign-in returned an invalid ID token', { cause: error });
    }
    if (typeof payload !== 'object' || payload === null || !('exp' in payload)
      || typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)
      || payload.exp * 1000 <= Date.now() + 60_000) {
      throw new Error('Firebase sign-in returned an expired or invalid ID token');
    }
    this.firebaseCredential = { token, expiresAt: payload.exp * 1000 };
    return token;
  }

  /**
   * Refresh the access token using the stored refresh token.
   */
  async refresh(): Promise<StoredTokens> {
    const generation = this.firebaseGeneration;
    if (this.refreshRequest?.generation === generation) return this.refreshRequest.promise;
    const promise = this.refreshImpl().finally(() => {
      if (this.refreshRequest?.promise === promise) this.refreshRequest = undefined;
    });
    this.refreshRequest = { generation, promise };
    return promise;
  }

  private async refreshImpl(): Promise<StoredTokens> {
    const generation = this.firebaseGeneration;
    if (!this.tokens?.refreshToken) {
      throw new Error('No refresh token available. Run login() first.');
    }

    let previous = this.tokens;
    const stored = await loadTokens(this.config.tokenFile, this.config.oauthBaseUrl, this.storageResource);
    this.assertGeneration(generation);
    if (stored?.refreshToken && stored.refreshToken !== previous.refreshToken) {
      previous = stored;
      this.tokens = stored;
      if (stored.expiresAt > Date.now() + 60_000) return stored;
    }
    const data = await this.oauthClient().token({
      grant_type: 'refresh_token',
      refresh_token: previous.refreshToken,
      client_id: this.config.clientId,
      resource: this.config.resource ?? this.config.mcpUrl,
    });
    const tokens = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? previous.refreshToken,
      expiresAt: Date.now() + data.expires_in * 1000,
    };

    await this.persist(tokens, generation);
    return tokens;
  }

  /**
   * Clear stored tokens (logout).
   */
  async logout(): Promise<void> {
    this.tokens = null;
    this.firebaseCredential = null;
    this.firebaseGeneration++;
    try {
      await this.cancelFirebaseSignIn?.();
    } finally {
      await Promise.allSettled([this.persistence]);
      await deleteTokens(this.config.tokenFile, this.config.oauthBaseUrl, this.storageResource);
    }
  }

  /**
   * Check if we have a valid (non-expired) token in memory.
   * Call `getAccessToken()` to also load from storage.
   */
  isAuthenticated(): boolean {
    return !!this.tokens && this.tokens.expiresAt > Date.now() + 60_000;
  }

  // ==========================================================================
  // Firebase sign-in
  // ==========================================================================

  private fetchFirebaseToken(): Promise<string> {
    return new Promise((resolve, reject) => {
      const state = crypto.randomUUID();
      const callbackUrl = `http://localhost:${this.config.firebaseAuthPort}/callback?state=${state}`;
      const loginUrl = `${this.config.loginUrl}?return_to=${encodeURIComponent(callbackUrl)}`;

      const server = http.createServer((req, res) => {
        res.setHeader('Connection', 'close');
        const url = new URL(req.url!, `http://localhost:${this.config.firebaseAuthPort}`);
        if (url.pathname !== '/callback' || url.searchParams.get('state') !== state) {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('Sign-in callback state is invalid.');
          return;
        }
        const token = url.searchParams.get('firebase_token');
        const error = url.searchParams.get('error');

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<html><body><h2>✅ Signed in — you can close this tab.</h2></body></html>');
        server.close();

        if (error) return reject(new Error(`Firebase auth error: ${error}`));
        if (!token) return reject(new Error('firebase_token missing from callback'));
        resolve(token);
      });

      const cancel = async () => {
        reject(new Error('Firebase sign-in was cancelled by logout. Sign in again.'));
        await new Promise<void>((closed, failed) => {
          server.close((error) => {
            if (error && (!('code' in error) || error.code !== 'ERR_SERVER_NOT_RUNNING')) failed(error);
            else closed();
          });
        });
      };
      this.cancelFirebaseSignIn = cancel;
      server.once('close', () => {
        if (this.cancelFirebaseSignIn === cancel) this.cancelFirebaseSignIn = undefined;
      });

      server.listen(this.config.firebaseAuthPort, () => {
        openBrowser(loginUrl);
      });

      server.on('error', reject);
    });
  }

  // ==========================================================================
  // OAuth 2.1 + PKCE
  // ==========================================================================

  private oauthClient(firebaseJwt?: string): OAuthClient {
    return new OAuthClient({
      baseUrl: this.config.oauthBaseUrl,
      getAccessToken: () => this.getAccessToken(),
      getFirebaseIdToken: () => firebaseJwt ? Promise.resolve(firebaseJwt) : this.getFirebaseIdToken(),
    });
  }

  private async fetchAuthCode(firebaseJwt: string, challenge: string): Promise<string> {
    const result = await this.oauthClient(firebaseJwt).authorize({
      response_type: 'code',
      client_id: this.config.clientId,
      redirect_uri: `http://localhost:${this.config.callbackPort}/callback`,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: crypto.randomUUID(),
      scope: this.config.scopes?.join(' ') ?? 'mcp',
      resource: this.config.resource ?? this.config.mcpUrl,
    });
    return result.code;
  }

  private exchangeCode(code: string, verifier: string): Promise<OAuthTokenResponse> {
    return this.oauthClient().token({
      grant_type: 'authorization_code',
      code,
      redirect_uri: `http://localhost:${this.config.callbackPort}/callback`,
      client_id: this.config.clientId,
      code_verifier: verifier,
      resource: this.config.resource ?? this.config.mcpUrl,
    });
  }

}

// ============================================================================
// Helpers
// ============================================================================

export function createPkce(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function openBrowser(url: string): void {
  const cmd =
    process.platform === 'darwin'
      ? `open "${url}"`
      : process.platform === 'win32'
        ? `start "" "${url}"`
        : `xdg-open "${url}"`;
  exec(cmd, () => {
    // Ignore errors — user can open manually
  });
}
