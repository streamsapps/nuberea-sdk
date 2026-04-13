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
const KEYCHAIN_ACCOUNT = 'tokens';

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

export function defaultTokenFile(): string {
  return path.join(stateDir(), 'tokens.json');
}

// ---------------------------------------------------------------------------
// Legacy migration
// ---------------------------------------------------------------------------

function migrateLegacyFile(tokenFile: string): void {
  const legacy = path.join(os.homedir(), '.nuberea', 'tokens.json');
  if (legacy === tokenFile) return; // same path, nothing to migrate
  try {
    if (!fs.existsSync(legacy)) return;
    if (fs.existsSync(tokenFile)) {
      // New file already exists — just clean up the old one
      fs.unlinkSync(legacy);
      return;
    }
    const dir = path.dirname(tokenFile);
    fs.mkdirSync(dir, { recursive: true });
    fs.renameSync(legacy, tokenFile);
    console.error(
      `nuberea: credentials migrated from ~/.nuberea/tokens.json → ${tokenFile}`,
    );
  } catch {
    // Best-effort — do not fail startup
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function saveTokens(tokens: PersistedTokens, tokenFile: string): Promise<void> {
  const keytar = loadKeytar();
  if (keytar) {
    try {
      await keytar.setPassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, JSON.stringify(tokens));
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

export async function loadTokens(tokenFile: string): Promise<PersistedTokens | null> {
  migrateLegacyFile(tokenFile);

  const keytar = loadKeytar();
  if (keytar) {
    try {
      const raw = await keytar.getPassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
      if (raw) return JSON.parse(raw) as PersistedTokens;
    } catch {
      // Keychain read failed — fall through to file
    }
  }

  try {
    const raw = fs.readFileSync(tokenFile, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    // Strip firebaseToken if it slipped into an old file
    return {
      accessToken: parsed.accessToken as string,
      refreshToken: parsed.refreshToken as string,
      expiresAt: parsed.expiresAt as number,
    };
  } catch {
    return null;
  }
}

export async function deleteTokens(tokenFile: string): Promise<void> {
  const keytar = loadKeytar();
  if (keytar) {
    try {
      await keytar.deletePassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
    } catch {
      // Ignore
    }
  }
  try { fs.unlinkSync(tokenFile); } catch { /* ok */ }
}
