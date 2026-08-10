import Fastify from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { config } from './config.js';

/** Constant-time compare so the token cannot be recovered by timing the 404s. */
function tokenMatches(candidate) {
  const a = Buffer.from(String(candidate));
  const b = Buffer.from(String(config.feedToken));
  return a.length === b.length && timingSafeEqual(a, b);
}

export function buildServer(state, { logger = true } = {}) {
  const app = Fastify({
    logger: logger && {
      // The feed token is a credential; keep it out of the logs.
      redact: {
        paths: ['req.url', 'req.headers.authorization'],
        censor: '[redacted]',
      },
    },
  });

  app.get('/healthz', async (_req, reply) => {
    const health = state.health;
    return reply.code(health.ok ? 200 : 503).send(health);
  });

  app.get('/:token/feed.ics', async (req, reply) => {
    if (!config.feedToken || !tokenMatches(req.params.token)) {
      // 404 rather than 401: an unauthenticated caller learns nothing about
      // whether this path serves anything at all.
      return reply.code(404).send({ error: 'Not found' });
    }

    return reply
      .header('Content-Type', 'text/calendar; charset=utf-8')
      .header('Content-Disposition', 'inline; filename="simkl.ics"')
      .header('Cache-Control', 'private, no-store')
      .send(state.ics);
  });

  return app;
}
