/**
 * Downloading an artwork candidate: the bytes the page chose, from the CDN
 * that serves them, bounded in size and host.
 *
 * The allowlist is checked **before** any request leaves: the URL a download
 * is asked for comes from a candidate record or from a `Banner` cell, and a
 * cell is hand-editable, so without the check the page would be a fetch proxy
 * for whatever a cell named. The content type is checked **after**, because
 * a CDN answering a 200 with an HTML error page is the failure that would
 * otherwise put a web page in the bucket under an image's name.
 */

import { HttpError, requestBytes, type HttpSpec } from './http.ts';
import { config } from '../shared/config.ts';
import type { RequestComponent } from './requests.ts';

/**
 * The CDNs an image may be fetched from: TMDB's for film candidates, TVDB's
 * for show candidates, and fanart.tv's, which offers nothing here but is what
 * five hand-picked `Banner` cells link — an adopt copies from wherever the
 * cell points, and a host off this list is refused before any request.
 */
export const IMAGE_HOSTS: readonly string[] = ['image.tmdb.org', 'artworks.thetvdb.com', 'assets.fanart.tv'];

/** Past this a candidate is not a backdrop; TMDB's largest original is under 6 MiB. */
export const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);

export class ImageError extends HttpError {
  constructor(message: string, status?: number, body?: string) {
    super(message, status, body);
    this.name = 'ImageError';
  }
}

const SPEC: HttpSpec = {
  service: 'images',
  label: 'Image CDN',
  maxAttempts: 3,
  timeoutMs: 60_000,
  errorFor: (message, status, body) => new ImageError(message, status, body),
  onStatus: (status, _body, path) => (RETRYABLE.has(status) ? 'retry' : new ImageError(`Image CDN ${status} for ${path}`, status)),
};

export interface FetchedImage {
  bytes: Uint8Array<ArrayBuffer>;
  /** The CDN's own, e.g. `image/jpeg`; what the object is stored under. */
  contentType: string;
}

/** Whether a URL is one a download may be made from. */
export const allowedImageUrl = (url: string, hosts: readonly string[] = IMAGE_HOSTS): URL | null => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  return parsed.protocol === 'https:' && hosts.includes(parsed.hostname) ? parsed : null;
};

export const fetchImage = async (
  url: string,
  { component, maxBytes = MAX_IMAGE_BYTES, hosts = IMAGE_HOSTS, signal }: { component: RequestComponent; maxBytes?: number; hosts?: readonly string[]; signal?: AbortSignal },
): Promise<FetchedImage> => {
  const parsed = allowedImageUrl(url, hosts);
  if (!parsed) throw new ImageError(`refusing to download ${url}: not on an image host (${hosts.join(', ')})`);
  const got = await requestBytes(SPEC, parsed, {
    component,
    maxBytes,
    signal,
    headers: () => ({ Accept: 'image/*', 'User-Agent': `${config.appName}/${config.appVersion}` }),
  });
  const contentType = got.contentType?.split(';')[0]?.trim().toLowerCase() ?? '';
  if (!contentType.startsWith('image/')) {
    throw new ImageError(`${parsed.hostname} answered ${parsed.pathname} with ${got.contentType ?? 'no content type'}, not an image`);
  }
  return { bytes: new Uint8Array(got.bytes), contentType };
};
