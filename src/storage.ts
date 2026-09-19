/**
 * NuBerea credential storage.
 *
 * Priority:
 *   1. OS Keychain  — macOS Keychain, Linux libsecret, Windows Credential Manager
 *      via `keytar` (optional dependency — if unavailable falls through silently)
 *   2. Filesystem   — XDG State Dir (platform-aware), mode 0o600
 *
 * Only `{ accessToken, refreshToken, expiresAt }` is ever persisted.
 * The Firebase login credential (firebaseToken) is intentionally never stored.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PersistedTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch ms
}

// ---------------------------------------------------------------------------
// Keychain (optional — keytar may not be installed)
// ---------------------------------------------------------------------------

const KEYCHAIN_SERVICE = 'nuberea';
const LEGACY_KEYCHAIN_ACCOUNT = 'tokens';

type Keytar = {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, password: string): Promise<void>;
  deletePassword(service: string, account: string): Promise<boolean>;
};

function loadKeytar(): Keytar | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('keytar') as Keytar;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Platform-aware file path
// ---------------------------------------------------------------------------

function stateDir(): string {
  const { platform } = process;
  const home = os.homedir();

  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'nuberea');
  }
  if (platform === 'win32') {
    return path.join(process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'nuberea');
  }
  // Linux / other: XDG_STATE_HOME (ephemeral runtime state, not config)
  const xdgState = process.env.XDG_STATE_HOME ?? path.join(home, '.local', 'state');
  return path.join(xdgState, 'nuberea');
}

export function tokenStoreAccount(oauthBaseUrl: string): string {
  return `tokens:${new URL(oauthBaseUrl).host}`;
}

export function defaultTokenFile(oauthBaseUrl?: string): string {
  const fileName = oauthBaseUrl
    ? `tokens-${new URL(oauthBaseUrl).host.replace(/[^A-Za-z0-9._-]/g, '_')}.json`
    : 'tokens.json';
  return path.join(stateDir(), fileName);
}

// ---------------------------------------------------------------------------
// Legacy migration
// ---------------------------------------------------------------------------

function readTokens(file: string): PersistedTokens | null {
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      accessToken: parsed.accessToken as string,
      refreshToken: parsed.refreshToken as string,
      expiresAt: parsed.expiresAt as number,
    };
  } catch {
    return null;
  }
}

function tokenMatchesOrigin(tokens: PersistedTokens, oauthBaseUrl: string): boolean {
  try {
    const payload = JSON.parse(
      Buffer.from(tokens.accessToken.split('.')[1], 'base64url').toString('utf8'),
    ) as { iss?: unknown };
    return typeof payload.iss === 'string'
      && new URL(payload.iss).origin === new URL(oauthBaseUrl).origin;
  } catch {
    return false;
  }
}

function migrateLegacyFile(tokenFile: string, oauthBaseUrl: string): PersistedTokens | null {
  if (fs.existsSync(tokenFile)) return readTokens(tokenFile);

  const legacyFiles = [
    path.join(stateDir(), 'tokens.json'),
    path.join(os.homedir(), '.nuberea', 'tokens.json'),
  ];
  for (const legacy of legacyFiles) {
    if (legacy === tokenFile || !fs.existsSync(legacy)) continue;
    const tokens = readTokens(legacy);
    if (!tokens || !tokenMatchesOrigin(tokens, oauthBaseUrl)) continue;

    const dir = path.dirname(tokenFile);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tokenFile, JSON.stringify(tokens, null, 2), { mode: 0o600 });
    return tokens;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function saveTokens(
  tokens: PersistedTokens,
  tokenFile: string,
  oauthBaseUrl: string,
): Promise<void> {
  const keytar = loadKeytar();
  if (keytar) {
    try {
      await keytar.setPassword(
        KEYCHAIN_SERVICE,
        tokenStoreAccount(oauthBaseUrl),
        JSON.stringify(tokens),
      );
      // Remove any stale file so we don't leave plaintext tokens on disk
      try { fs.unlinkSync(tokenFile); } catch { /* ok */ }
      return;
    } catch {
      // Keychain write failed — fall through to file storage
    }
  }

  const dir = path.dirname(tokenFile);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(tokenFile, JSON.stringify(tokens, null, 2), { mode: 0o600 });
}

export async function loadTokens(
  tokenFile: string,
  oauthBaseUrl: string,
): Promise<PersistedTokens | null> {
  const keytar = loadKeytar();
  if (keytar) {
    try {
      const account = tokenStoreAccount(oauthBaseUrl);
      const raw = await keytar.getPassword(KEYCHAIN_SERVICE, account);
      if (raw) return JSON.parse(raw) as PersistedTokens;

      const legacy = await keytar.getPassword(KEYCHAIN_SERVICE, LEGACY_KEYCHAIN_ACCOUNT);
      if (legacy) {
        const tokens = JSON.parse(legacy) as PersistedTokens;
        if (tokenMatchesOrigin(tokens, oauthBaseUrl)) {
          await keytar.setPassword(KEYCHAIN_SERVICE, account, legacy);
          return tokens;
        }
      }
    } catch {
      // Keychain read failed — fall through to file
    }
  }

  return readTokens(tokenFile) ?? migrateLegacyFile(tokenFile, oauthBaseUrl);
}

export async function deleteTokens(tokenFile: string, oauthBaseUrl: string): Promise<void> {
  const keytar = loadKeytar();
  if (keytar) {
    try {
      await keytar.deletePassword(KEYCHAIN_SERVICE, tokenStoreAccount(oauthBaseUrl));
    } catch {
      // Ignore
    }
  }
  try { fs.unlinkSync(tokenFile); } catch { /* ok */ }
}
