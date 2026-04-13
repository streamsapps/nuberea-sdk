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
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

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
}

export interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch ms
  firebaseToken?: string;
}

const DEFAULT_CONFIG: AuthConfig = {
  oauthBaseUrl: 'https://auth.aws-dev.streamsappsgslbex.com',
  mcpUrl: 'https://auth.aws-dev.streamsappsgslbex.com/mcp',
  clientId: 'mcp-client-test',
  callbackPort: 9876,
  firebaseAuthPort: 9875,
  tokenFile: path.join(os.homedir(), '.nuberea', 'tokens.json'),
  loginUrl: 'https://nuberea.com/login',
};

export class NuBereaAuth {
  private config: AuthConfig;
  private tokens: StoredTokens | null = null;

  constructor(config?: Partial<AuthConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ==========================================================================
  // Public API
  // ==========================================================================

  /**
   * Get a valid access token, refreshing or re-authenticating as needed.
   */
  async getAccessToken(): Promise<string> {
    // Try loading from disk
    if (!this.tokens) {
      this.tokens = this.loadTokens();
    }

    // Still valid?
    if (this.tokens && this.tokens.expiresAt > Date.now() + 60_000) {
      return this.tokens.accessToken;
    }

    // Try refresh
    if (this.tokens?.refreshToken) {
      try {
        await this.refresh();
        return this.tokens!.accessToken;
      } catch {
        // Refresh failed — fall through to full login
      }
    }

    // Full login flow
    await this.login();
    return this.tokens!.accessToken;
  }

  /**
   * Run the full interactive login flow (opens browser).
   */
  async login(firebaseToken?: string): Promise<StoredTokens> {
    const fbToken = firebaseToken ?? await this.fetchFirebaseToken();
    const { verifier, challenge } = generatePkce();
    const code = await this.fetchAuthCode(fbToken, challenge);
    const tokenResponse = await this.exchangeCode(code, verifier);

    this.tokens = {
      accessToken: tokenResponse.access_token,
      refreshToken: tokenResponse.refresh_token,
      expiresAt: Date.now() + tokenResponse.expires_in * 1000,
      firebaseToken: fbToken,
    };

    this.saveTokens(this.tokens);
    return this.tokens;
  }

  /**
   * Refresh the access token using the stored refresh token.
   */
  async refresh(): Promise<StoredTokens> {
    if (!this.tokens?.refreshToken) {
      throw new Error('No refresh token available. Run login() first.');
    }

    const res = await fetch(`${this.config.oauthBaseUrl}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: this.tokens.refreshToken,
        client_id: this.config.clientId,
        resource: this.config.mcpUrl,
      }).toString(),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Token refresh failed: HTTP ${res.status} — ${body}`);
    }

    const data = await res.json() as TokenResponse;
    this.tokens = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? this.tokens.refreshToken,
      expiresAt: Date.now() + data.expires_in * 1000,
      firebaseToken: this.tokens.firebaseToken,
    };

    this.saveTokens(this.tokens);
    return this.tokens;
  }

  /**
   * Clear stored tokens (logout).
   */
  logout(): void {
    this.tokens = null;
    try {
      fs.unlinkSync(this.config.tokenFile);
    } catch {
      // File may not exist
    }
  }

  /**
   * Check if we have a valid (non-expired) token.
   */
  isAuthenticated(): boolean {
    if (!this.tokens) this.tokens = this.loadTokens();
    return !!this.tokens && this.tokens.expiresAt > Date.now() + 60_000;
  }

  // ==========================================================================
  // Firebase sign-in
  // ==========================================================================

  private fetchFirebaseToken(): Promise<string> {
    return new Promise((resolve, reject) => {
      const callbackUrl = `http://localhost:${this.config.firebaseAuthPort}/callback`;
      const loginUrl = `${this.config.loginUrl}?return_to=${encodeURIComponent(callbackUrl)}`;

      const server = http.createServer((req, res) => {
        const url = new URL(req.url!, `http://localhost:${this.config.firebaseAuthPort}`);
        const token = url.searchParams.get('firebase_token');
        const error = url.searchParams.get('error');

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<html><body><h2>✅ Signed in — you can close this tab.</h2></body></html>');
        server.close();

        if (error) return reject(new Error(`Firebase auth error: ${error}`));
        if (!token) return reject(new Error('firebase_token missing from callback'));
        resolve(token);
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

  private fetchAuthCode(firebaseJwt: string, challenge: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const redirectUri = `http://localhost:${this.config.callbackPort}/callback`;

      const params = new URLSearchParams({
        response_type: 'code',
        client_id: this.config.clientId,
        redirect_uri: redirectUri,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state: crypto.randomBytes(8).toString('hex'),
        scope: 'mcp',
        resource: this.config.mcpUrl,
      });

      const authorizeUrl = `${this.config.oauthBaseUrl}/authorize?${params}`;

      // Call authorize directly with Firebase token
      fetch(authorizeUrl, {
        method: 'GET',
        redirect: 'manual',
        headers: { Authorization: `Bearer ${firebaseJwt}` },
      })
        .then((res) => {
          const location = res.headers.get('location');
          if (!location) throw new Error(`Expected redirect from /authorize, got HTTP ${res.status}`);

          const url = new URL(location.startsWith('http') ? location : `${redirectUri}${location}`);
          const code = url.searchParams.get('code');
          const error = url.searchParams.get('error');

          if (error) throw new Error(`OAuth error: ${error}`);
          if (!code) throw new Error(`No code in redirect: ${location}`);
          resolve(code);
        })
        .catch(reject);
    });
  }

  private async exchangeCode(code: string, verifier: string): Promise<TokenResponse> {
    const redirectUri = `http://localhost:${this.config.callbackPort}/callback`;

    const res = await fetch(`${this.config.oauthBaseUrl}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: this.config.clientId,
        code_verifier: verifier,
        resource: this.config.mcpUrl,
      }).toString(),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Token exchange failed: HTTP ${res.status} — ${body}`);
    }

    return res.json() as Promise<TokenResponse>;
  }

  // ==========================================================================
  // Token persistence
  // ==========================================================================

  private loadTokens(): StoredTokens | null {
    try {
      const raw = fs.readFileSync(this.config.tokenFile, 'utf-8');
      return JSON.parse(raw) as StoredTokens;
    } catch {
      return null;
    }
  }

  private saveTokens(tokens: StoredTokens): void {
    const dir = path.dirname(this.config.tokenFile);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.config.tokenFile, JSON.stringify(tokens, null, 2), { mode: 0o600 });
  }
}

// ============================================================================
// Helpers
// ============================================================================

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
}

function generatePkce(): { verifier: string; challenge: string } {
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
