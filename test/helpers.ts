/**
 * Shared test fixtures.
 *
 * Two of these exist to stop a whole class of accident rather than to save
 * typing. `withTempDataDir` was duplicated across two files; more importantly
 * `config.dataDir` defaults to ./data, which on a real checkout holds a live
 * OAuth token — so any test that builds a FeedState without overriding it would
 * make authenticated calls to SIMKL. `stubFetch` closes the same hole for the
 * network: nothing in the suite should ever reach the real CDN or API.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../src/config.ts';

/** A logger that records nothing, for states under test. */
export const quiet = { info() {}, warn() {}, error() {} };

/** A logger that keeps what it was told, for asserting on reported failures. */
export const recorder = () => {
  const lines: string[] = [];
  return {
    lines,
    info: (m: string) => void lines.push(`info: ${m}`),
    warn: (m: string) => void lines.push(`warn: ${m}`),
    error: (m: string) => void lines.push(`error: ${m}`),
  };
};

/** Point config.dataDir at a fresh directory for the duration of `fn`. */
export const withTempDataDir = async (fn: (dir: string) => Promise<void>): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), 'simkl-ical-test-'));
  const original = config.dataDir;
  config.dataDir = dir;
  try {
    await fn(dir);
  } finally {
    config.dataDir = original;
    await rm(dir, { recursive: true, force: true });
  }
};

export type FetchHandler = (url: string, init?: RequestInit) => Response | Promise<Response>;

/**
 * Replace global fetch for the duration of `fn`, and record every URL asked for.
 *
 * The call log is what most of these tests actually assert on — that a poll made
 * one request rather than eight, or that a failure was retried the right number
 * of times.
 */
export const withFetch = async (handler: FetchHandler, fn: (calls: string[]) => Promise<void>): Promise<void> => {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    return handler(url, init);
  }) as typeof fetch;
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
};

/** A JSON 200, with an optional Last-Modified so conditional GETs can be tested. */
export const jsonResponse = (body: unknown, { lastModified }: { lastModified?: string } = {}): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: lastModified ? { 'content-type': 'application/json', 'last-modified': lastModified } : { 'content-type': 'application/json' },
  });

/** A minimal but well-formed calendar file. */
export const calendarFile = (calendar: unknown[] = [], metadata: Record<string, unknown> = {}) => ({ calendar, metadata });
