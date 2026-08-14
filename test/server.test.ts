import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { buildServer } from '../src/server.ts';
import { FeedState } from '../src/refresh.ts';
import { quiet, withConfig } from './helpers.ts';

const TOKEN = 'a'.repeat(48);

interface ServerCase {
  /** The configured feed token. `null` means none is set at all. */
  token?: string | null;
  logStream?: NodeJS.WritableStream;
}

/** Build a server with a known feed token, restoring config afterwards. */
const withServer = async (
  fn: (app: ReturnType<typeof buildServer>, state: FeedState) => Promise<void>,
  { token = TOKEN, logStream }: ServerCase = {},
): Promise<void> => {
  await withConfig({ feedToken: token ?? undefined }, async () => {
    const state = new FeedState({ logger: quiet });
    const app = buildServer(state, { logger: Boolean(logStream), logStream });
    try {
      await fn(app, state);
    } finally {
      await app.close();
    }
  });
};

test('the right token serves the feed as a calendar', async () => {
  await withServer(async (app, state) => {
    const res = await app.inject({ method: 'GET', url: `/${TOKEN}/feed.ics` });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['content-type'], 'text/calendar; charset=utf-8');
    assert.match(String(res.headers['content-disposition']), /filename="simkl\.ics"/);
    assert.equal(res.headers['cache-control'], 'private, no-store');
    assert.equal(res.body, state.ics);
  });
});

test('a wrong token is a 404', async () => {
  await withServer(async (app) => {
    const res = await app.inject({ method: 'GET', url: '/b'.repeat(24) + '/feed.ics' });
    assert.equal(res.statusCode, 404);
  });
});

// The bug this guards: timingSafeEqual throws on unequal lengths. The length
// check in tokenMatches is what keeps a short token a 404 rather than a 500,
// and nothing exercised it — removing the guard left the suite green.
test('a token of the wrong length is a 404, not a 500', async () => {
  await withServer(async (app) => {
    for (const wrong of ['x', 'a'.repeat(47), 'a'.repeat(49), 'a'.repeat(400)]) {
      const res = await app.inject({ method: 'GET', url: `/${wrong}/feed.ics` });
      assert.equal(res.statusCode, 404, `length ${wrong.length} should 404`);
    }
  });
});

// Fastify caps path parameters at 100 characters by default, so a token longer
// than that produced a 414 and an unreachable feed rather than a 404.
test('a longer feed token is usable', async () => {
  const long = 'c'.repeat(128); // e.g. openssl rand -hex 64
  await withServer(
    async (app) => {
      assert.equal((await app.inject({ method: 'GET', url: `/${long}/feed.ics` })).statusCode, 200);
      assert.equal((await app.inject({ method: 'GET', url: `/${'d'.repeat(128)}/feed.ics` })).statusCode, 404);
    },
    { token: long },
  );
});

test('a token that is a prefix of the real one is rejected', async () => {
  await withServer(async (app) => {
    const res = await app.inject({ method: 'GET', url: `/${TOKEN.slice(0, -1)}/feed.ics` });
    assert.equal(res.statusCode, 404);
  });
});

test('with no token configured the feed is unreachable rather than open', async () => {
  await withServer(
    async (app) => {
      for (const url of ['//feed.ics', `/${TOKEN}/feed.ics`, '/undefined/feed.ics']) {
        assert.equal((await app.inject({ method: 'GET', url })).statusCode, 404, url);
      }
    },
    { token: null },
  );
});

// 404 rather than 401 only hides the route if every 404 looks the same. It did
// not: a wrong token returned {"error":"Not found"} while any other path
// returned Fastify's default body, which names the route it failed to match.
test('a wrong token is indistinguishable from any other missing path', async () => {
  await withServer(async (app) => {
    const wrongToken = await app.inject({ method: 'GET', url: '/nope/feed.ics' });
    const otherPath = await app.inject({ method: 'GET', url: '/something/else' });
    const root = await app.inject({ method: 'GET', url: '/' });

    assert.equal(wrongToken.statusCode, 404);
    assert.equal(otherPath.statusCode, 404);
    assert.equal(root.statusCode, 404);
    assert.equal(otherPath.body, wrongToken.body, 'bodies must match');
    assert.equal(root.body, wrongToken.body, 'bodies must match');
    assert.ok(!otherPath.body.includes('something'), 'the path must not be echoed back');
  });
});

test('healthz is 503 until a render has happened, and 200 after', async () => {
  await withServer(async (app, state) => {
    const before = await app.inject({ method: 'GET', url: '/healthz' });
    assert.equal(before.statusCode, 503);
    assert.equal(before.json().ok, false);

    state.renderedAt = new Date().toISOString();
    state.calendarsFreshAt = new Date().toISOString();
    state.polledAt = new Date().toISOString();

    const after = await app.inject({ method: 'GET', url: '/healthz' });
    assert.equal(after.statusCode, 200);
    assert.equal(after.json().ok, true);
  });
});

test('healthz needs no token and leaks no credential', async () => {
  await withServer(async (app) => {
    const body = (await app.inject({ method: 'GET', url: '/healthz' })).body;
    assert.ok(!body.includes(TOKEN), 'the feed token must not appear in health');
    assert.ok(!body.includes('client'), 'nor anything client-id shaped');
  });
});

// The token sits in the URL path, so request logging would write it to disk on
// every poll. Fastify's serializer emits no headers, so `req.url` is the only
// path that matters — and it is the one that has to work.
test('the feed token never reaches the logs', async () => {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(String(chunk));
      cb();
    },
  });

  await withServer(
    async (app) => {
      await app.inject({ method: 'GET', url: `/${TOKEN}/feed.ics` });
      assert.ok(lines.length > 0, 'the request should have been logged at all');
      const logged = lines.join('');
      assert.ok(!logged.includes(TOKEN), `token leaked into logs: ${logged}`);
      assert.ok(logged.includes('[redacted]'), 'the url should be redacted, not merely absent');
    },
    { logStream: stream },
  );
});
