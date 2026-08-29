import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { config } from './shared/config.ts';
import type { Orchestrator } from './orchestrator.ts';
import { assess, healthResponse } from './health.ts';
import { renderStatus } from './status/status.ts';

/** Constant-time compare so the token cannot be recovered by timing the 404s. */
const tokenMatches = (candidate: string): boolean => {
  const a = Buffer.from(String(candidate));
  const b = Buffer.from(String(config.feedToken));
  return a.length === b.length && timingSafeEqual(a, b);
};

/**
 * The origin the reader actually reached the status page on, for the copyable
 * feed URL it prints. `Host` is what this browser asked for, so it is right by
 * construction, and a proxy's `x-forwarded-proto` is the only way to know the
 * scheme survived. It reaches the page as *text* only — the link's href is
 * root-relative, so a forged header cannot aim a click off-origin.
 */
const originOf = (req: FastifyRequest): string => {
  const forwarded = req.headers['x-forwarded-proto'];
  // A chain of proxies sends a list; the first entry is the client's scheme.
  const proto = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim() || req.protocol;
  return `${proto}://${req.headers.host ?? `localhost:${config.port}`}`;
};

/** The one 404 body. Every miss answers with this — see setNotFoundHandler. */
const NOT_FOUND = { error: 'Not found' };

export interface ServerOptions {
  logger?: boolean;
  /** Where the logger writes. Defaults to stdout; tests assert on the output. */
  logStream?: NodeJS.WritableStream;
}

export const buildServer = (state: Orchestrator, { logger = true, logStream }: ServerOptions = {}): FastifyInstance => {
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
        .header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'")
        .header('Referrer-Policy', 'no-referrer')
        .header('X-Content-Type-Options', 'nosniff')
        .header('Cache-Control', 'private, no-store')
        .send(renderStatus(state, { origin: originOf(req) }))
    );
  });

  return app;
};
