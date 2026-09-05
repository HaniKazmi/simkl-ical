import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { artworkConfigured, config } from './shared/config.ts';
import { errorMessage } from './shared/errors.ts';
import type { Orchestrator } from './orchestrator.ts';
import { assess, healthResponse } from './health.ts';
import { renderStatus } from './status/status.ts';
import { ICON_APPLE, ICON_ICO, ICON_SVG } from './status/icons.ts';
import { Artwork, PickRefused } from './artwork/artwork.ts';
import { renderArtwork } from './artwork/page.ts';
import { CLIENT_SCRIPT } from './artwork/client.ts';
import { SheetBusyError } from './sheet/io/lock.ts';

/** Constant-time compare so the token cannot be recovered by timing the 404s. */
const tokenMatches = (candidate: string): boolean => {
  const a = Buffer.from(String(candidate));
  const b = Buffer.from(String(config.feedToken));
  return a.length === b.length && timingSafeEqual(a, b);
};

/**
 * The origin the reader actually reached the status page on, for the copyable
 * feed URL it prints, and — since `webcal:` needs a full authority — the one
 * click target on the page not fixed by config. `Host` is what this browser
 * asked for, so it is right by construction; a proxy that forwards a forged
 * one aims the subscribe link elsewhere, and a subscription is durable, so
 * that keeps re-fetching with the token. `PUBLIC_URL` is the fix if `Host`
 * ever stops being trustworthy here.
 *
 * The scheme is checked against the two that exist rather than passed through:
 * it is client-settable, and anything else survives the `^https?:` rewrite in
 * `status.ts` unchanged and lands in an `href` verbatim. An uppercase `HTTPS`
 * from a proxy is the same defect without an attacker.
 */
const originOf = (req: FastifyRequest): string => {
  const forwarded = req.headers['x-forwarded-proto'];
  // A chain of proxies sends a list; the first entry is the client's scheme.
  const claimed = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim().toLowerCase();
  const proto = claimed === 'https' || claimed === 'http' ? claimed : req.protocol;
  return `${proto}://${req.headers.host ?? `localhost:${config.port}`}`;
};

/** The one 404 body. Every miss answers with this — see setNotFoundHandler. */
const NOT_FOUND = { error: 'Not found' };

export interface ServerOptions {
  logger?: boolean;
  /** Where the logger writes. Defaults to stdout; tests assert on the output. */
  logStream?: NodeJS.WritableStream;
  /** The artwork shell, built here by default; a test passes one with a shorter lock wait. */
  artwork?: Artwork;
}

/**
 * The artwork page's CSP. Unlike the status page it runs a script and loads
 * images off-origin, so both are named: the script is `'self'` only, and
 * images may come from the two candidate CDNs and the buckets and nowhere
 * else. `connect-src 'self'` is what the script's own fetches run under.
 * Pinned exactly by `server.test.ts`.
 */
export const ARTWORK_CSP =
  "default-src 'none'; img-src 'self' https://image.tmdb.org https://artworks.thetvdb.com https://storage.googleapis.com; " +
  "script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";

/** The statuses a pick's refusal maps to. */
const PICK_STATUS: Record<PickRefused['code'], number> = {
  'unknown-title': 404,
  'not-offered': 400,
  formula: 422,
  'needs-adopt': 409,
  unrecognised: 422,
  'no-id': 422,
  'nothing-to-adopt': 400,
};

export const buildServer = (state: Orchestrator, { logger = true, logStream, artwork = new Artwork(state) }: ServerOptions = {}): FastifyInstance => {
  const app = Fastify({
    // Fastify caps path parameters at 100 characters by default; a longer
    // feed token would get a 414 instead of the 404 below, and an
    // unreachable feed.
    routerOptions: { maxParamLength: 512 },
    logger: logger && {
      ...(logStream ? { stream: logStream } : {}),
      // The token sits in the path, so an unredacted request log repeats the
      // credential once per request. The logs are a trusted surface — boot
      // prints the token in full — so this is volume control, not a
      // disclosure boundary.
      redact: {
        paths: ['req.url'],
        censor: '[redacted]',
      },
    },
  });

  // Every miss answers identically. Fastify's default body names the missed
  // route, which would make a wrong token distinguishable from any other 404.
  app.setNotFoundHandler((_req, reply) => reply.code(404).send(NOT_FOUND));

  app.get('/healthz', async (_req, reply) => {
    const snapshot = state.snapshot();
    const assessment = assess(snapshot);
    return reply.code(assessment.ok ? 200 : 503).send(healthResponse(snapshot, assessment));
  });

  app.get<{ Params: { token: string } }>('/:token/feed.ics', async (req, reply) => {
    if (!config.feedToken || !tokenMatches(req.params.token)) {
      // 404, not 401, with the same body as any other miss: an
      // unauthenticated caller learns nothing about whether this path serves
      // anything.
      return reply.code(404).send(NOT_FOUND);
    }

    return reply
      .header('Content-Type', 'text/calendar; charset=utf-8')
      .header('Content-Disposition', 'inline; filename="simkl.ics"')
      .header('Cache-Control', 'private, no-store')
      .send(state.ics);
  });

  // Under the token like everything else, so the icons add no path that answers differently to a
  // caller without one. Cached hard: they change only when this binary does.
  for (const [name, type, body] of [
    ['favicon.svg', 'image/svg+xml', ICON_SVG],
    ['favicon.ico', 'image/x-icon', ICON_ICO],
    ['apple-touch-icon.png', 'image/png', ICON_APPLE],
  ] as const) {
    app.get<{ Params: { token: string } }>(`/:token/${name}`, async (req, reply) => {
      if (!config.feedToken || !tokenMatches(req.params.token)) {
        return reply.code(404).send(NOT_FOUND);
      }
      return reply
        .header('Content-Type', type)
        .header('Cache-Control', 'private, max-age=86400')
        .header('X-Content-Type-Options', 'nosniff')
        .send(body);
    });
  }

  app.get<{ Params: { token: string } }>('/:token/status', async (req, reply) => {
    if (!config.feedToken || !tokenMatches(req.params.token)) {
      // The same body as any other 404, so the route cannot be found by
      // probing.
      return reply.code(404).send(NOT_FOUND);
    }

    return (
      reply
        // Set here rather than on the route, so the 404 above never acquires it.
        .header('Content-Type', 'text/html; charset=utf-8')
        // The feed token is in this page's URL, which browser history and
        // bookmark sync keep. `default-src 'none'` with no script-src means
        // an escaping bug cannot execute; no-referrer stops the token riding
        // out on any request the page makes — also why it loads nothing
        // off-origin.
        //
        // `img-src 'self'` is what lets the icons load at all: under
        // `default-src 'none'` a browser declines to fetch even a favicon this
        // page names. Same-origin only, so an injected `<img>` still has
        // nowhere off-host to carry the token to.
        .header(
          'Content-Security-Policy',
          "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
        )
        .header('Referrer-Policy', 'no-referrer')
        .header('X-Content-Type-Options', 'nosniff')
        .header('Cache-Control', 'private, no-store')
        .send(renderStatus(state, { origin: originOf(req), artwork: artworkConfigured() ? { url: `${originOf(req)}/${config.feedToken ?? ''}/artwork`, ...artwork.summary() } : null }))
    );
  });

  // --- The artwork page --------------------------------------------------------
  //
  // Four routes under the token, all 404 exactly like a wrong token when the
  // feature is not configured, so an unconfigured install exposes no path
  // that answers differently.

  const artworkGate = (token: string): boolean => Boolean(config.feedToken) && tokenMatches(token) && artworkConfigured();

  app.get<{ Params: { token: string }; Querystring: { fresh?: string } }>('/:token/artwork', async (req, reply) => {
    if (!artworkGate(req.params.token)) return reply.code(404).send(NOT_FOUND);
    const page = await renderArtwork(artwork, { fresh: req.query.fresh === '1' });
    return reply
      .header('Content-Type', 'text/html; charset=utf-8')
      .header('Content-Security-Policy', ARTWORK_CSP)
      // The token is in this page's URL and the page loads images off-origin;
      // this is what keeps it out of their logs.
      .header('Referrer-Policy', 'no-referrer')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Cache-Control', 'private, no-store')
      .send(page);
  });

  app.get<{ Params: { token: string } }>('/:token/artwork/app.js', async (req, reply) => {
    if (!artworkGate(req.params.token)) return reply.code(404).send(NOT_FOUND);
    return reply
      .header('Content-Type', 'text/javascript; charset=utf-8')
      .header('X-Content-Type-Options', 'nosniff')
      // Its JSON contract changes with the binary, so it is never cached past a deploy.
      .header('Cache-Control', 'private, no-store')
      .send(CLIENT_SCRIPT);
  });

  const kindOf = (value: unknown): 'movie' | 'show' | null => (value === 'movie' || value === 'show' ? value : null);
  const idOf = (value: unknown): number | null => {
    const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
    return Number.isInteger(n) && n > 0 ? n : null;
  };

  app.get<{ Params: { token: string }; Querystring: { kind?: string; id?: string } }>('/:token/artwork/candidates', async (req, reply) => {
    if (!artworkGate(req.params.token)) return reply.code(404).send(NOT_FOUND);
    const kind = kindOf(req.query.kind);
    const id = idOf(req.query.id);
    if (!kind || id === null) return reply.code(400).send({ error: 'bad-request', detail: 'kind must be movie or show, and id a positive integer' });
    try {
      return reply.header('Cache-Control', 'private, no-store').send(await artwork.candidates(kind, id));
    } catch (err) {
      if (err instanceof PickRefused) return reply.code(PICK_STATUS[err.code]).send({ error: err.code, detail: err.message });
      return reply.code(502).send({ error: 'upstream', detail: errorMessage(err) });
    }
  });

  app.post<{ Params: { token: string }; Body: unknown }>('/:token/artwork/pick', async (req, reply) => {
    if (!artworkGate(req.params.token)) return reply.code(404).send(NOT_FOUND);
    const body = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as Record<string, unknown>;
    const kind = kindOf(body.kind);
    const id = idOf(body.id);
    const url = typeof body.url === 'string' ? body.url : undefined;
    const adopt = body.adopt === true;
    if (!kind || id === null) return reply.code(400).send({ error: 'bad-request', detail: 'kind must be movie or show, and id a positive integer' });
    try {
      const result = await artwork.pick(kind, id, { url, adopt });
      return reply.header('Cache-Control', 'private, no-store').send({ ok: true, ...result });
    } catch (err) {
      if (err instanceof PickRefused) return reply.code(PICK_STATUS[err.code]).send({ error: err.code, detail: err.message });
      if (err instanceof SheetBusyError) return reply.code(503).header('Retry-After', '10').send({ error: 'busy', detail: err.message });
      return reply.code(502).send({ error: 'upstream', detail: errorMessage(err) });
    }
  });

  return app;
};
