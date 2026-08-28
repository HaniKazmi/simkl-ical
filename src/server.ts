import Fastify, { type FastifyInstance } from 'fastify';
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

/** The one 404 body. Every miss answers with this — see setNotFoundHandler. */
const NOT_FOUND = { error: 'Not found' };

export interface ServerOptions {
  logger?: boolean;
  /** Where the logger writes. Defaults to stdout; tests assert on the output. */
  logStream?: NodeJS.WritableStream;
}

export const buildServer = (state: Orchestrator, { logger = true, logStream }: ServerOptions = {}): FastifyInstance => {
  const app = Fastify({
    // The feed token is a path parameter and Fastify caps those at 100
    // characters by default, which a longer token would exceed — a 414 rather
    // than the 404 below, and an unreachable feed.
    routerOptions: { maxParamLength: 512 },
    logger: logger && {
      ...(logStream ? { stream: logStream } : {}),
      // The token sits in the path, so an unredacted request log is a log of
      // the credential once per request. The logs are a trusted surface here —
      // the boot lines print the token in full — so this is not a disclosure
      // boundary; it keeps the volume of a long-lived log down to the one line
      // at startup that an operator actually wants to copy.
      redact: {
        paths: ['req.url'],
        censor: '[redacted]',
      },
    },
  });

  // Every miss answers identically. Fastify's default body names the route it
  // failed to match, which would make a wrong token distinguishable from any
  // other 404 — exactly what the 404 below is meant to prevent.
  app.setNotFoundHandler((_req, reply) => reply.code(404).send(NOT_FOUND));

  app.get('/healthz', async (_req, reply) => {
    const snapshot = state.snapshot();
    const assessment = assess(snapshot);
    return reply.code(assessment.ok ? 200 : 503).send(healthResponse(snapshot, assessment));
  });

  app.get<{ Params: { token: string } }>('/:token/feed.ics', async (req, reply) => {
    if (!config.feedToken || !tokenMatches(req.params.token)) {
      // 404 rather than 401, with the same body as any other miss: an
      // unauthenticated caller learns nothing about whether this path serves
      // anything at all.
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
      // The same body as the feed's miss and as any other 404, so the route
      // cannot be discovered by probing.
      return reply.code(404).send(NOT_FOUND);
    }

    return (
      reply
        // Set here rather than on the route, so the 404 above never acquires it.
        .header('Content-Type', 'text/html; charset=utf-8')
        // The feed token is in this page's URL, which browser history, bookmark
        // sync and screenshots all keep. No script-src at all under
        // `default-src 'none'` means an escaping bug cannot execute, and
        // no-referrer stops the token riding out on any request the page makes
        // — which is also why it loads nothing off-origin.
        .header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'")
        .header('Referrer-Policy', 'no-referrer')
        .header('X-Content-Type-Options', 'nosniff')
        .header('Cache-Control', 'private, no-store')
        .send(renderStatus(state))
    );
  });

  return app;
};
