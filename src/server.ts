import Fastify, { type FastifyInstance } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { config } from './shared/config.ts';
import type { Health } from './orchestrator.ts';

/** Constant-time compare so the token cannot be recovered by timing the 404s. */
const tokenMatches = (candidate: string): boolean => {
  const a = Buffer.from(String(candidate));
  const b = Buffer.from(String(config.feedToken));
  return a.length === b.length && timingSafeEqual(a, b);
};

/** The one 404 body. Every miss answers with this — see setNotFoundHandler. */
const NOT_FOUND = { error: 'Not found' };

/**
 * What the routes need, and nothing more. Declared here so the server does not
 * know how the service is composed — `Orchestrator` satisfies it structurally.
 */
export interface FeedService {
  readonly ics: string;
  readonly health: Health;
}

export interface ServerOptions {
  logger?: boolean;
  /** Where the logger writes. Defaults to stdout; tests assert on the output. */
  logStream?: NodeJS.WritableStream;
}

export const buildServer = (state: FeedService, { logger = true, logStream }: ServerOptions = {}): FastifyInstance => {
  const app = Fastify({
    // The feed token is a path parameter and Fastify caps those at 100
    // characters by default, which a longer token would exceed — a 414 rather
    // than the 404 below, and an unreachable feed.
    routerOptions: { maxParamLength: 512 },
    logger: logger && {
      ...(logStream ? { stream: logStream } : {}),
      // The feed token is a credential and it sits in the path. Only `req.url`
      // needs redacting: Fastify's request serializer emits no headers.
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
    const health = state.health;
    return reply.code(health.ok ? 200 : 503).send(health);
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

  return app;
};
