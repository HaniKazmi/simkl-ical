import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
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

export const writeToken = async (accessToken: string): Promise<string> => {
  await mkdir(config.dataDir, { recursive: true });
  const path = tokenPath();
  await writeFile(path, JSON.stringify({ access_token: accessToken, saved_at: new Date().toISOString() }, null, 2));
  await chmod(path, 0o600);
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
