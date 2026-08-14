import Fastify, { type FastifyInstance } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { config } from './config.ts';
import type { FeedState } from './refresh.ts';

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

export const buildServer = (state: FeedState, { logger = true, logStream }: ServerOptions = {}): FastifyInstance => {
  const app = Fastify({
    // The feed token is a path parameter, and Fastify's default cap is 100
    // characters. `openssl rand -hex 24` fits, but anyone who generated a
    // longer one got a 414 and an unreachable feed with no useful explanation.
    maxParamLength: 512,
    logger: logger && {
      ...(logStream ? { stream: logStream } : {}),
      // The feed token is a credential; keep it out of the logs. Only `req.url`
      // matters: Fastify's request serializer emits no headers at all, so a
      // rule for req.headers.authorization would be decoration rather than
      // protection.
      redact: {
        paths: ['req.url'],
        censor: '[redacted]',
      },
    },
  });

  // Without this the claim below is false: a wrong token returned this body
  // while any other path returned Fastify's default, which names the route.
  // The two were trivially distinguishable, which is exactly what the 404 is
  // supposed to prevent.
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
