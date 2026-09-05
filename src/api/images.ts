/**
 * Downloading an artwork candidate or an adopted image: the bytes a cell or
 * a candidate names, from any public https host, bounded in size.
 *
 * Any host, because the URL can come from a hand-edited `Banner` cell and
 * the point of adopting is to copy whatever the sheet links. What that must
 * not become is a way to make this process fetch from its own network: the
 * hostname is resolved **before** the request and refused if any address is
 * loopback, private, link-local or the cloud metadata range — that, not a
 * host list, is what stops a cell naming `http://169.254.169.254/…`. A
 * redirect is not followed, since followed it would land wherever the first
 * hop pointed, past every check here. The content type is checked
 * **after**, because a host answering a 200 with an HTML error page is the
 * failure that would otherwise put a web page in the bucket under an image's
 * name.
 *
 * The resolver runs once and `fetch` resolves again, so a name that answers
 * differently the second time (DNS rebinding) is not caught. The cell is the
 * operator's own, behind the feed token; this guards against a mistake, not
 * an adversary with write access to the spreadsheet.
 */

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { HttpError, requestBytes, type HttpSpec } from './http.ts';
import { config } from '../shared/config.ts';
import { errorMessage } from '../shared/errors.ts';
import type { RequestComponent } from './requests.ts';

/** The CDNs candidates come from — TMDB's for films, TVDB's for shows. What the page offers, not what it may fetch. */
export const CANDIDATE_HOSTS: readonly string[] = ['image.tmdb.org', 'artworks.thetvdb.com'];

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
  label: 'Image host',
  maxAttempts: 3,
  timeoutMs: 60_000,
  errorFor: (message, status, body) => new ImageError(message, status, body),
  onStatus: (status, _body, path) =>
    RETRYABLE.has(status)
      ? 'retry'
      : status >= 300 && status < 400
        ? new ImageError(`Image host answered ${path} with a ${status} redirect, which is not followed`, status)
        : new ImageError(`Image host ${status} for ${path}`, status),
};

export interface FetchedImage {
  bytes: Uint8Array<ArrayBuffer>;
  /** The host's own, e.g. `image/jpeg`; what the object is stored under. */
  contentType: string;
}

/** A URL a download may be asked for: https, with a hostname. Where it resolves is checked at fetch time. */
export const allowedImageUrl = (url: string): URL | null => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || !parsed.hostname) return null;
  // A literal address is checked here, so a cell naming one is refused
  // without a lookup; a name is checked once resolved.
  if (isIP(parsed.hostname.replace(/^\[|\]$/g, '')) && !isPublicAddress(parsed.hostname.replace(/^\[|\]$/g, ''))) return null;
  return parsed;
};

const v4 = (ip: string): number[] | null => {
  const parts = ip.split('.').map(Number);
  return parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? parts : null;
};

/**
 * Whether an address is one on the public internet, as opposed to this
 * host, its network, or the cloud metadata service. IPv4-mapped IPv6 is
 * judged as the IPv4 inside it.
 */
export const isPublicAddress = (ip: string): boolean => {
  const kind = isIP(ip);
  if (kind === 4) {
    const [a, b] = v4(ip) ?? [];
    if (a === undefined || b === undefined) return false;
    if (a === 0 || a === 10 || a === 127) return false; // this network, private, loopback
    if (a === 169 && b === 254) return false; // link-local, and the metadata service
    if (a === 172 && b >= 16 && b <= 31) return false; // private
    if (a === 192 && b === 168) return false; // private
    if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
    if (a >= 224) return false; // multicast and reserved
    return true;
  }
  if (kind === 6) {
    const lower = ip.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped?.[1]) return isPublicAddress(mapped[1]);
    if (lower === '::1' || lower === '::') return false; // loopback, unspecified
    if (/^f[cd]/.test(lower)) return false; // unique local, fc00::/7
    if (/^fe[89ab]/.test(lower)) return false; // link-local, fe80::/10
    if (/^ff/.test(lower)) return false; // multicast
    return true;
  }
  return false;
};

/** A hostname's addresses. Injectable so a test never touches DNS. */
export type Resolver = (hostname: string) => Promise<string[]>;

export const systemResolver: Resolver = async (hostname) => (await lookup(hostname, { all: true })).map((a) => a.address);

export interface FetchImageOptions {
  component: RequestComponent;
  maxBytes?: number;
  resolve?: Resolver;
  signal?: AbortSignal;
}

export const fetchImage = async (url: string, { component, maxBytes = MAX_IMAGE_BYTES, resolve = systemResolver, signal }: FetchImageOptions): Promise<FetchedImage> => {
  const parsed = allowedImageUrl(url);
  if (!parsed) throw new ImageError(`refusing to download ${url}: not an https URL on a public host`);
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (!isIP(host)) {
    let addresses: string[];
    try {
      addresses = await resolve(host);
    } catch (err) {
      throw new ImageError(`refusing to download ${url}: ${host} does not resolve (${errorMessage(err)})`);
    }
    if (addresses.length === 0 || !addresses.every(isPublicAddress)) {
      throw new ImageError(`refusing to download ${url}: ${host} resolves to a private or local address`);
    }
  }
  const got = await requestBytes(SPEC, parsed, {
    component,
    maxBytes,
    signal,
    redirect: 'manual',
    headers: () => ({ Accept: 'image/*', 'User-Agent': `${config.appName}/${config.appVersion}` }),
  });
  const contentType = got.contentType?.split(';')[0]?.trim().toLowerCase() ?? '';
  if (!contentType.startsWith('image/')) {
    throw new ImageError(`${parsed.hostname} answered ${parsed.pathname} with ${got.contentType ?? 'no content type'}, not an image`);
  }
  return { bytes: new Uint8Array(got.bytes), contentType };
};
