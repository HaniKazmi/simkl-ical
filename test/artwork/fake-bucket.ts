/**
 * An in-memory Cloud Storage plus the image CDNs, composed **in front of**
 * `fakeSheets` for the whole-run suites: it answers what it knows and hands
 * the rest on. One fake, like the Sheets one, because it is coupled to the
 * client's URL shapes and a second copy is a second place that breaks quietly.
 */

import { createHash } from 'node:crypto';
import { jsonResponse } from '../helpers.ts';

export interface FakeObject {
  bytes: Uint8Array;
  contentType: string;
  cacheControl?: string;
  updated?: string;
}

export interface RecordedUpload {
  bucket: string;
  key: string;
  contentType: string;
  cacheControl: string | undefined;
  predefinedAcl: string | null;
  bytes: number;
}

export interface FakeBucketOptions {
  /** Objects already in each bucket, by key. */
  buckets?: Record<string, Record<string, FakeObject>>;
  /** What the image CDNs serve, by full URL. Anything else is a 404. */
  images?: Record<string, { bytes: Uint8Array; contentType: string }>;
  /** Objects per listing page; small in the pagination test. */
  pageSize?: number;
  /** A status to answer the nth upload with instead of storing it. */
  failUpload?: { call: number; status: number };
  /** Answer every storage request with this status. */
  storageStatus?: number;
  /** Store an upload's bytes with a corrupted MD5 in the response. */
  corruptMd5?: boolean;
  /** Everything not storage or an image host. Throws by default: a test that reaches it forgot a fake. */
  next?: (url: string, init?: RequestInit) => Response | Promise<Response>;
}

const parseMultipart = (body: Uint8Array, boundary: string): { metadata: { name?: string; contentType?: string; cacheControl?: string }; contentType: string; bytes: Uint8Array } => {
  const text = Buffer.from(body).toString('latin1');
  const delimiter = `--${boundary}`;
  const parts = text.split(delimiter).slice(1, -1);
  const [meta, media] = parts;
  if (!meta || !media) throw new Error('multipart body did not carry two parts');
  const metaJson = meta.slice(meta.indexOf('\r\n\r\n') + 4).replace(/\r\n$/, '');
  const headerEnd = media.indexOf('\r\n\r\n');
  const mediaHeaders = media.slice(0, headerEnd);
  const contentType = /Content-Type: ([^\r\n]+)/i.exec(mediaHeaders)?.[1] ?? '';
  // Offsets in latin1 are byte offsets, so the media part can be sliced out of the original bytes.
  const start = text.indexOf(media) + headerEnd + 4;
  const end = start + media.length - headerEnd - 4 - 2;
  return { metadata: JSON.parse(metaJson) as { name?: string; contentType?: string; cacheControl?: string }, contentType, bytes: body.slice(start, end) };
};

export const fakeBucket = ({ buckets = {}, images = {}, pageSize = 1000, failUpload, storageStatus, corruptMd5 = false, next }: FakeBucketOptions = {}) => {
  const stores = new Map<string, Map<string, FakeObject>>();
  for (const [bucket, objects] of Object.entries(buckets)) stores.set(bucket, new Map(Object.entries(objects)));
  const uploads: RecordedUpload[] = [];
  let listings = 0;

  const handler = async (url: string, init?: RequestInit): Promise<Response> => {
    const parsed = new URL(url);
    if (parsed.host === 'oauth2.googleapis.com') return jsonResponse({ access_token: 'storage-token', expires_in: 3600 });

    if (parsed.host === 'storage.googleapis.com') {
      if (storageStatus !== undefined) return new Response(JSON.stringify({ error: { message: 'storage said no' } }), { status: storageStatus });
      const upload = /^\/upload\/storage\/v1\/b\/([^/]+)\/o$/.exec(parsed.pathname);
      if (upload) {
        const bucket = decodeURIComponent(upload[1]!);
        const store = stores.get(bucket);
        if (!store) return new Response(JSON.stringify({ error: { message: 'The specified bucket does not exist.' } }), { status: 404 });
        if (failUpload && uploads.length + 1 === failUpload.call) {
          uploads.push({ bucket, key: parsed.searchParams.get('name') ?? '', contentType: '', cacheControl: undefined, predefinedAcl: null, bytes: 0 });
          return new Response(JSON.stringify({ error: { message: 'upload failed' } }), { status: failUpload.status });
        }
        const boundary = /boundary=(.+)$/.exec(new Headers(init?.headers).get('content-type') ?? '')?.[1];
        if (!boundary) throw new Error('upload without a multipart boundary');
        const raw = init?.body instanceof Uint8Array ? init.body : new Uint8Array(await new Response(init?.body as BodyInit).arrayBuffer());
        const { metadata, contentType, bytes } = parseMultipart(raw, boundary);
        const key = parsed.searchParams.get('name') ?? metadata.name ?? '';
        store.set(key, { bytes, contentType: metadata.contentType ?? contentType, cacheControl: metadata.cacheControl, updated: '2026-09-01T00:00:00Z' });
        uploads.push({ bucket, key, contentType: metadata.contentType ?? contentType, cacheControl: metadata.cacheControl, predefinedAcl: parsed.searchParams.get('predefinedAcl'), bytes: bytes.byteLength });
        const md5 = createHash('md5').update(bytes).digest('base64');
        return jsonResponse({ name: key, size: String(bytes.byteLength), md5Hash: corruptMd5 ? `x${md5.slice(1)}` : md5, contentType: metadata.contentType ?? contentType, updated: '2026-09-01T00:00:00Z' });
      }
      const list = /^\/storage\/v1\/b\/([^/]+)\/o$/.exec(parsed.pathname);
      if (list) {
        listings += 1;
        const bucket = decodeURIComponent(list[1]!);
        const store = stores.get(bucket);
        if (!store) return new Response(JSON.stringify({ error: { message: 'The specified bucket does not exist.' } }), { status: 404 });
        const names = [...store.keys()].sort();
        const from = Number(parsed.searchParams.get('pageToken') ?? 0);
        const page = names.slice(from, from + pageSize);
        const items = page.map((name) => {
          const object = store.get(name)!;
          return { name, size: String(object.bytes.byteLength), updated: object.updated ?? '2026-08-01T00:00:00Z' };
        });
        const more = from + pageSize < names.length;
        return jsonResponse(more ? { items, nextPageToken: String(from + pageSize) } : { items });
      }
      throw new Error(`fake bucket: unexpected storage request ${url}`);
    }

    if (parsed.host === 'image.tmdb.org' || parsed.host === 'artworks.thetvdb.com') {
      const image = images[url];
      if (!image) return new Response('not found', { status: 404 });
      return new Response(new Uint8Array(image.bytes), { status: 200, headers: { 'content-type': image.contentType } });
    }

    if (next) return next(url, init);
    throw new Error(`fake bucket: unexpected request ${url}`);
  };

  return {
    handler,
    uploads,
    /** The objects a bucket holds now. */
    objects: (bucket: string): Map<string, FakeObject> => stores.get(bucket) ?? new Map(),
    get listings() {
      return listings;
    },
  };
};

export type FakeBucket = ReturnType<typeof fakeBucket>;

/** A few bytes that are recognisably a JPEG header, for any test needing an image. */
export const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
