import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { artworkConfigured, config } from './shared/config.ts';
import { errorMessage } from './shared/errors.ts';
import type { Orchestrator } from './orchestrator.ts';
import { assess, healthResponse } from './health.ts';
import { renderStatus } from './status/status.ts';
import { ICON_APPLE, ICON_ICO, ICON_SVG } from './status/icons.ts';
import { Artwork, PickRefused } from './artwork/artwork.ts';
import { ARTWORK_KINDS, type ArtworkKind } from './artwork/1-index.ts';
import { renderArtwork } from './artwork/page.ts';
import { CLIENT_SCRIPT } from './artwork/client.ts';
import { SheetBusyError } from './sheet/io/lock.ts';

/**
 * The origin the reader actually reached the status page on, for the copyable
 * feed URL it prints, and — since `webcal:` needs a full authority — the one
 * click target on the page not fixed by config. `Host` is what this browser
 * asked for, so it is right by construction; a proxy that forwards a forged
 * one aims the subscribe link elsewhere, and a subscription is durable, so a
 * calendar keeps fetching the wrong address for as long as it lives.
 * `PUBLIC_URL` is the fix if `Host` ever stops being trustworthy here.
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

/** What an artwork route answers while the page is not configured. */
const NOT_FOUND = { error: 'Not found' };

export interface ServerOptions {
  logger?: boolean;
  /** The artwork shell, built here by default; a test passes one with a shorter lock wait. */
  artwork?: Artwork;
}

/**
 * The artwork page's CSP. Unlike the status page it runs a script and loads
 * images off-origin, so both are named: the script is `'self'` only, and
 * images may come from any https host — a cell may link any public host and
 * the row shows what it links — with the `no-referrer` header keeping the
 * page's URL out of their logs. `connect-src 'self'` is what the script's
 * own fetches run under. Pinned exactly by `server-artwork.test.ts`.
 */
export const ARTWORK_CSP =
  "default-src 'none'; img-src 'self' https:; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";

/** The statuses a pick's refusal maps to. */
const PICK_STATUS: Record<PickRefused['code'], number> = {
  'unknown-title': 404,
  'not-offered': 400,
  formula: 422,
  'needs-adopt': 409,
  unrecognised: 422,
  'no-id': 422,
  'nothing-to-adopt': 400,
  frozen: 409,
  'no-season': 404,
};

/**
 * What an artwork route answers when its call throws: a refusal at its own
 * status, a held sheet as "try again" — only a pick can meet one, waiting on
 * the lock — and anything else as the upstream's failure.
 */
const failed = (reply: FastifyReply, err: unknown): FastifyReply => {
  if (err instanceof PickRefused) return reply.code(PICK_STATUS[err.code]).send({ error: err.code, detail: err.message });
  if (err instanceof SheetBusyError) return reply.code(503).header('Retry-After', '10').send({ error: 'busy', detail: err.message });
  return reply.code(502).send({ error: 'upstream', detail: errorMessage(err) });
};

export const buildServer = (state: Orchestrator, { logger = true, artwork = new Artwork(state) }: ServerOptions = {}): FastifyInstance => {
  const app = Fastify({ logger });

  app.get('/healthz', async (_req, reply) => {
    const snapshot = state.snapshot();
    const assessment = assess(snapshot);
    return reply.code(assessment.ok ? 200 : 503).send(healthResponse(snapshot, assessment));
  });

  app.get('/feed.ics', async (_req, reply) => {
    return reply
      .header('Content-Type', 'text/calendar; charset=utf-8')
      .header('Content-Disposition', 'inline; filename="simkl.ics"')
      .header('Cache-Control', 'private, no-store')
      .send(state.ics);
  });

  // Cached hard: they change only when this binary does.
  for (const [name, type, body] of [
    ['favicon.svg', 'image/svg+xml', ICON_SVG],
    ['favicon.ico', 'image/x-icon', ICON_ICO],
    ['apple-touch-icon.png', 'image/png', ICON_APPLE],
  ] as const) {
    app.get(`/${name}`, async (_req, reply) => {
      return reply
        .header('Content-Type', type)
        .header('Cache-Control', 'private, max-age=86400')
        .header('X-Content-Type-Options', 'nosniff')
        .send(body);
    });
  }

  app.get('/status', async (req, reply) => {
    return (
      reply
        .header('Content-Type', 'text/html; charset=utf-8')
        // Every title, sheet cell and upstream error on this page is
        // interpolated. `default-src 'none'` with no script-src means an
        // escaping bug cannot execute, and an injected tag has nowhere
        // off-origin to load from.
        //
        // `img-src 'self'` is what lets the icons load at all: under
        // `default-src 'none'` a browser declines to fetch even a favicon this
        // page names.
        .header(
          'Content-Security-Policy',
          "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
        )
        .header('Referrer-Policy', 'no-referrer')
        .header('X-Content-Type-Options', 'nosniff')
        .header('Cache-Control', 'private, no-store')
        .send(renderStatus(state, { origin: originOf(req), artwork: artworkConfigured() ? { url: `${originOf(req)}/artwork`, ...artwork.summary() } : null }))
    );
  });

  // --- The artwork page --------------------------------------------------------
  //
  // Every route 404s while the feature is not configured.
  //
  // `POST artwork/pick` uploads to a bucket and writes the sheet, and nothing
  // authenticates it. What keeps another site's page from making a reader's
  // browser call it is the body: a cross-site request that needs no CORS
  // preflight is form, multipart or `text/plain`. Fastify answers the first
  // two 415 and hands the third to the route as a string, which names no kind
  // and is answered 400. The preflight a JSON request needs finds no CORS
  // handler here, so the browser never sends it. Adding a CORS plugin, or a parser that turns a form or
  // `text/plain` body into an object, opens that route to every site the
  // reader visits — pinned in `server-artwork.test.ts`.

  app.get<{ Querystring: { fresh?: string } }>('/artwork', async (req, reply) => {
    if (!artworkConfigured()) return reply.code(404).send(NOT_FOUND);
    const page = await renderArtwork(artwork, { fresh: req.query.fresh === '1' });
    return reply
      .header('Content-Type', 'text/html; charset=utf-8')
      .header('Content-Security-Policy', ARTWORK_CSP)
      // The page loads images from whatever hosts the cells link; this keeps
      // the service's own address out of their logs.
      .header('Referrer-Policy', 'no-referrer')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Cache-Control', 'private, no-store')
      .send(page);
  });

  app.get('/artwork/app.js', async (_req, reply) => {
    if (!artworkConfigured()) return reply.code(404).send(NOT_FOUND);
    return reply
      .header('Content-Type', 'text/javascript; charset=utf-8')
      .header('X-Content-Type-Options', 'nosniff')
      // Its JSON contract changes with the binary, so it is never cached past a deploy.
      .header('Cache-Control', 'private, no-store')
      .send(CLIENT_SCRIPT);
  });

  const kindOf = (value: unknown): ArtworkKind | null => (ARTWORK_KINDS.includes(value as ArtworkKind) ? (value as ArtworkKind) : null);
  const idOf = (value: unknown): number | null => {
    const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
    return Number.isInteger(n) && n > 0 ? n : null;
  };

  app.get<{ Querystring: { kind?: string; id?: string } }>('/artwork/candidates', async (req, reply) => {
    if (!artworkConfigured()) return reply.code(404).send(NOT_FOUND);
    const kind = kindOf(req.query.kind);
    const id = idOf(req.query.id);
    if (!kind || id === null) return reply.code(400).send({ error: 'bad-request', detail: 'kind must be movie, show or book, and id a positive integer' });
    try {
      return reply.header('Cache-Control', 'private, no-store').send(await artwork.candidates(kind, id));
    } catch (err) {
      return failed(reply, err);
    }
  });

  // A show's season rows and the TVDB posters each can take; the panel a show
  // row opens into below its own strip.
  app.get<{ Querystring: { id?: string } }>('/artwork/seasons', async (req, reply) => {
    if (!artworkConfigured()) return reply.code(404).send(NOT_FOUND);
    const id = idOf(req.query.id);
    if (id === null) return reply.code(400).send({ error: 'bad-request', detail: 'id must be a positive integer' });
    try {
      return reply.header('Cache-Control', 'private, no-store').send(await artwork.seasons(id));
    } catch (err) {
      return failed(reply, err);
    }
  });

  app.post<{ Body: unknown }>('/artwork/pick', async (req, reply) => {
    if (!artworkConfigured()) return reply.code(404).send(NOT_FOUND);
    const body = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as Record<string, unknown>;
    const kind = kindOf(body.kind);
    const id = idOf(body.id);
    const url = typeof body.url === 'string' ? body.url : undefined;
    const adopt = body.adopt === true;
    if (!kind || id === null) return reply.code(400).send({ error: 'bad-request', detail: 'kind must be movie, show or book, and id a positive integer' });
    // A season is a number as the tab holds it, `7.5` included, and only a
    // show has rows to hold one. Absent means the title's own cell.
    const season = body.season;
    if (season !== undefined && (kind !== 'show' || typeof season !== 'number' || !Number.isFinite(season) || season < 0)) {
      return reply.code(400).send({ error: 'bad-request', detail: 'season must be a number, and only on a show' });
    }
    try {
      const result = await artwork.pick(kind, id, { url, adopt, season });
      return reply.header('Cache-Control', 'private, no-store').send({ ok: true, ...result });
    } catch (err) {
      return failed(reply, err);
    }
  });

  return app;
};
