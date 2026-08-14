import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../config.ts';
import { apiGet } from './client.ts';
import type { PinResponse } from './types.ts';

const tokenPath = (): string => join(config.dataDir, 'token.json');

export const readToken = async (): Promise<string | null> => {
  try {
    const raw = await readFile(tokenPath(), 'utf8');
    return (JSON.parse(raw) as { access_token?: string }).access_token ?? null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
};

/**
 * Save the access token, 0600, without ever exposing it more widely.
 *
 * Write-and-rename rather than write-then-chmod. `writeFile` creates at
 * 0666 & ~umask — typically 0644 — so narrowing afterwards leaves a window
 * where the token is world-readable, and `mode` alone does not help when the
 * file already exists, because an existing file keeps its old mode. Writing a
 * fresh inode with the mode set and renaming it into place has neither
 * problem, and makes the replacement atomic into the bargain.
 */
export const writeToken = async (accessToken: string): Promise<string> => {
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  const path = tokenPath();
  const body = JSON.stringify({ access_token: accessToken, saved_at: new Date().toISOString() }, null, 2);
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, body, { mode: 0o600 });
  await rename(tmp, path);
  return path;
};

export interface Pin {
  userCode: string;
  verificationUrl: string;
  expiresIn: number;
  intervalSeconds: number;
}

/**
 * Start the device flow.
 *
 * Note: SIMKL returns the literal string "DEVICE_CODE" for `device_code` —
 * it is a placeholder, not a real code. Polling is keyed on `user_code`,
 * which is the value shown to the user. Verified against the live API.
 */
export const requestPin = async (): Promise<Pin> => {
  const res = await apiGet<PinResponse>('/oauth/pin');
  if (res.result && res.result !== 'OK') {
    throw new Error(`Could not start PIN flow: ${res.message ?? JSON.stringify(res)}`);
  }
  return {
    userCode: res.user_code,
    verificationUrl: res.verification_url ?? res.verification_uri ?? 'https://simkl.com/pin',
    expiresIn: res.expires_in ?? 900,
    intervalSeconds: res.interval ?? 5,
  };
};

/** One poll. Returns an access token, or null while the user hasn't approved yet. */
export const pollPin = async (userCode: string): Promise<string | null> => {
  const res = await apiGet<PinResponse>(`/oauth/pin/${encodeURIComponent(userCode)}`);
  if (res.result === 'OK' && res.access_token) return res.access_token;
  return null;
};

export interface LoginHooks {
  onPrompt?: (pin: Pin) => void;
  onTick?: (secondsLeft: number) => void;
}

/**
 * Full device flow. `onPrompt` receives the code to display; polling runs
 * until the user approves or the code expires.
 */
export const login = async ({ onPrompt = () => {}, onTick = () => {} }: LoginHooks = {}): Promise<string> => {
  const pin = await requestPin();
  onPrompt(pin);

  const deadline = Date.now() + pin.expiresIn * 1000;
  const intervalMs = pin.intervalSeconds * 1000;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));
    const token = await pollPin(pin.userCode);
    if (token) return token;
    onTick(Math.max(0, Math.round((deadline - Date.now()) / 1000)));
  }

  throw new Error(`Code ${pin.userCode} expired before it was approved. Run the login again.`);
};
