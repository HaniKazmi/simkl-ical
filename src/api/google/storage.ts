/**
 * Transport for Cloud Storage's JSON API: list a bucket, put an object.
 *
 * The same credential as Sheets under its own scope, and the same retry
 * posture as the reads there — an upload is idempotent, since a re-send puts
 * the same bytes under the same key, so it retries where `batchUpdate` may
 * not.
 *
 * Multipart rather than `uploadType=media`: only the multipart form carries
 * the metadata, and `cacheControl` is metadata. Without it a public object
 * is cached for an hour by default, and a re-pick would take that long to
 * show on the site.
 */

import { createHash } from 'node:crypto';
import { HttpError, requestJson, type HttpSpec } from '../http.ts';
import { config } from '../../shared/config.ts';
import type { RequestComponent } from '../requests.ts';
import { clearTokenCache, getAccessToken, SCOPES } from './auth.ts';
import { instantFrom } from '../../shared/dates.ts';

const API_BASE = 'https://storage.googleapis.com/storage/v1/b/';
const UPLOAD_BASE = 'https://storage.googleapis.com/upload/storage/v1/b/';

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);

const MAX_ATTEMPTS = 4;

/** A page of a listing. Google's ceiling; every bucket here fits in one. */
const PAGE_SIZE = 1000;

export class StorageError extends HttpError {
  constructor(message: string, status?: number, body?: string) {
    super(message, status, body);
    this.name = 'StorageError';
  }
}

/**
 * "The service account may not" and "the bucket does not exist", both of which
 * need a person: an IAM grant or a corrected bucket name, not a retry.
 */
export class StorageAccessError extends StorageError {
  readonly needsHuman: boolean;

  constructor(message: string, status?: number, body?: string, { needsHuman = true }: { needsHuman?: boolean } = {}) {
    super(message, status, body);
    this.name = 'StorageAccessError';
    this.needsHuman = needsHuman;
  }
}

const describe = (status: number, body: string): string => {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } };
    if (parsed.error?.message) return `${status} ${parsed.error.message}`;
  } catch {
    // An HTML error page from a proxy; the status is all there is.
  }
  return `${status}`;
};

const SPEC: HttpSpec = {
  service: 'storage',
  label: 'Storage',
  maxAttempts: MAX_ATTEMPTS,
  timeoutMs: 60_000,
  errorFor: (message, status, body) => new StorageError(message, status, body),
  onStatus: (status, body, path) => {
    if (status === 401) {
      clearTokenCache();
      return new StorageAccessError(`Google rejected the credential (${describe(status, body)})`, status, body, { needsHuman: false });
    }
    if (status === 403) {
      // The grant is named because the near miss is the common one:
      // `objectCreator` lets the first upload through and refuses the
      // overwrite a re-pick needs.
      return new StorageAccessError(`${describe(status, body)} — grant the service account roles/storage.objectAdmin on the bucket.`, status, body);
    }
    if (status === 404) return new StorageAccessError(`${describe(status, body)} — check the bucket name.`, status, body);
    if (RETRYABLE.has(status)) return 'retry';
    return new StorageError(`Storage ${describe(status, body)} for ${path}`, status, body);
  },
};

const headers = async (): Promise<Record<string, string>> => ({
  Authorization: `Bearer ${await getAccessToken({ scope: SCOPES.storage })}`,
  Accept: 'application/json',
  'User-Agent': `${config.appName}/${config.appVersion}`,
});

/** The object resource, as much of it as is read. Sizes come back as strings. */
interface ObjectResource {
  name?: string;
  size?: string;
  md5Hash?: string;
  contentType?: string;
  updated?: string;
}

export interface StoredObject {
  size: number;
  /** Null when the listing carries no parseable stamp. */
  updated: Temporal.Instant | null;
}

/**
 * Every object in a bucket, by name. Paged, though no bucket here has needed
 * a second page; the `fields` mask keeps the payload to what is read.
 */
export const listObjects = async (bucket: string, { component, signal }: { component: RequestComponent; signal?: AbortSignal }): Promise<Map<string, StoredObject>> => {
  const objects = new Map<string, StoredObject>();
  let pageToken: string | undefined;
  do {
    const url = new URL(`${API_BASE}${encodeURIComponent(bucket)}/o`);
    url.searchParams.set('fields', 'items(name,size,updated),nextPageToken');
    url.searchParams.set('maxResults', String(PAGE_SIZE));
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const page = await requestJson<{ items?: ObjectResource[]; nextPageToken?: string }>(SPEC, url, {
      component,
      headers,
      path: `/b/${bucket}/o`,
      signal,
    });
    for (const item of page.items ?? []) {
      if (item.name) objects.set(item.name, { size: Number(item.size ?? 0), updated: instantFrom(item.updated) });
    }
    pageToken = page.nextPageToken;
  } while (pageToken);
  return objects;
};

export interface UploadOptions {
  component: RequestComponent;
  contentType: string;
  cacheControl: string;
  /**
   * Whether to ask for `allUsers` read on the object itself. Right on a
   * bucket with legacy ACLs, where a new object is otherwise private; wrong
   * on one with uniform bucket-level access, which answers the request with
   * a 400 and where the bucket's own policy already makes the object public.
   */
  publicRead: boolean;
  signal?: AbortSignal;
}

export interface Uploaded {
  bucket: string;
  key: string;
  bytes: number;
  contentType: string;
}

/**
 * Put an object, overwriting whatever the key held, and check the stored
 * size and MD5 against what was sent — the one way to know the bytes on the
 * far side are the bytes the page chose.
 */
export const uploadObject = async (bucket: string, key: string, bytes: Uint8Array<ArrayBuffer>, { component, contentType, cacheControl, publicRead, signal }: UploadOptions): Promise<Uploaded> => {
  const url = new URL(`${UPLOAD_BASE}${encodeURIComponent(bucket)}/o`);
  url.searchParams.set('uploadType', 'multipart');
  url.searchParams.set('name', key);
  if (publicRead) url.searchParams.set('predefinedAcl', 'publicRead');

  const boundary = `simkl-ical-${createHash('sha1').update(bytes).digest('hex').slice(0, 16)}`;
  const metadata = JSON.stringify({ name: key, contentType, cacheControl });
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`),
    bytes,
    Buffer.from(`\r\n--${boundary}--`),
  ]);

  const stored = await requestJson<ObjectResource>(SPEC, url, {
    component,
    method: 'POST',
    headers,
    rawBody: { bytes: new Uint8Array(body), contentType: `multipart/related; boundary=${boundary}` },
    path: `/b/${bucket}/o`,
    signal,
  });

  const size = Number(stored.size);
  const md5 = createHash('md5').update(bytes).digest('base64');
  if (size !== bytes.byteLength || (stored.md5Hash && stored.md5Hash !== md5)) {
    throw new StorageError(`Storage stored ${bucket}/${key} as ${stored.size ?? '?'} bytes, md5 ${stored.md5Hash ?? '?'}; sent ${bytes.byteLength} bytes, md5 ${md5}`);
  }
  return { bucket, key, bytes: size, contentType: stored.contentType ?? contentType };
};
