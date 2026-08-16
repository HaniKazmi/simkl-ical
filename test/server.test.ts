import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { buildServer } from '../src/server.ts';
import { Orchestrator } from '../src/orchestrator.ts';
import { config } from '../src/shared/config.ts';
import { quiet, withConfig } from './helpers.ts';

const TOKEN = 'a'.repeat(48);

interface ServerCase {
  /** The configured feed token. `null` means none is set at all. */
  token?: string | null;
  logStream?: NodeJS.WritableStream;
}

/** Build a server with a known feed token, restoring config afterwards. */
const withServer = async (
  fn: (app: ReturnType<typeof buildServer>, state: Orchestrator) => Promise<void>,
  { token = TOKEN, logStream }: ServerCase = {},
): Promise<void> => {
  await withConfig({ feedToken: token ?? undefined }, async () => {
    const state = new Orchestrator({ logger: quiet });
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
    assert.equal(res.body, state.feed.ics);
  });
});

test('a wrong token is a 404', async () => {
  await withServer(async (app) => {
    const res = await app.inject({ method: 'GET', url: '/b'.repeat(24) + '/feed.ics' });
    assert.equal(res.statusCode, 404);
  });
});

// timingSafeEqual throws on unequal lengths, so the length check in
// tokenMatches is what keeps a short token a 404 rather than a 500.
test('a token of the wrong length is a 404, not a 500', async () => {
  await withServer(async (app) => {
    for (const wrong of ['x', 'a'.repeat(47), 'a'.repeat(49), 'a'.repeat(400)]) {
      const res = await app.inject({ method: 'GET', url: `/${wrong}/feed.ics` });
      assert.equal(res.statusCode, 404, `length ${wrong.length} should 404`);
    }
  });
});

// Fastify caps path parameters at 100 characters by default, which a longer
// token would exceed — a 414 and an unreachable feed.
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

// 404 rather than 401 only hides the route if every 404 looks the same;
// Fastify's default body names the route it failed to match.
test('a wrong token is indistinguishable from any other missing path', async () => {
  await withServer(async (app) => {
    const wrongToken = await app.inject({ method: 'GET', url: '/nope/feed.ics' });
    const wrongStatus = await app.inject({ method: 'GET', url: '/nope/status' });
    const otherPath = await app.inject({ method: 'GET', url: '/something/else' });
    const root = await app.inject({ method: 'GET', url: '/' });

    assert.equal(wrongToken.statusCode, 404);
    assert.equal(wrongStatus.statusCode, 404);
    assert.equal(otherPath.statusCode, 404);
    assert.equal(root.statusCode, 404);
    assert.equal(wrongStatus.body, wrongToken.body, 'the status page is no more discoverable than the feed');
    assert.equal(wrongStatus.headers['content-type'], otherPath.headers['content-type'], 'and a miss is never HTML');
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

    state.feed.renderedAt = new Date().toISOString();
    state.feed.calendarsFreshAt = new Date().toISOString();
    state.polledAt = new Date().toISOString();

    const after = await app.inject({ method: 'GET', url: '/healthz' });
    assert.equal(after.statusCode, 200);
    assert.equal(after.json().ok, true);
  });
});

test('healthz needs no token', async () => {
  await withServer(async (app) => {
    assert.equal((await app.inject({ method: 'GET', url: '/healthz' })).statusCode, 503);
  });
});

// A container healthcheck is a contract, and the key set is the contract: CI
// parses this body, and so does anything an operator has pointed at it. tsc
// checks the keys exist but never their order, and `JSON.stringify` emits
// insertion order, so only an assertion holds the shape.
test('the healthz body is state and shape, in a stable order', async () => {
  await withServer(async (app) => {
    const body = (await app.inject({ method: 'GET', url: '/healthz' })).json();

    assert.deepEqual(Object.keys(body), ['ok', 'timezone', 'library', 'feed', 'sheet']);
    assert.deepEqual(Object.keys(body.library), ['polledAt', 'syncedAt']);
    assert.deepEqual(Object.keys(body.feed), ['events', 'renderedAt', 'servingCached', 'calendars']);
    assert.deepEqual(Object.keys(body.feed.calendars), ['attemptedAt', 'freshAt']);
    assert.deepEqual(Object.keys(body.sheet), ['configured', 'mode', 'status', 'lastRunAt', 'frozen']);
  });
});

// The diagnostic half is the status page's job: a healthcheck that carries
// free text carries wording that changes, in a body a machine parses.
test('the healthz body carries no free-text diagnostics', async () => {
  await withServer(async (app, state) => {
    state.errors.library = 'AUTH: SIMKL rejected the token';
    state.errors.sheet = 'the spreadsheet is not shared with the service account';
    state.feed.errors.render = 'render blew up';

    const response = await app.inject({ method: 'GET', url: '/healthz' });
    const body = response.body;

    assert.doesNotMatch(body, /SIMKL rejected/);
    assert.doesNotMatch(body, /not shared/);
    assert.doesNotMatch(body, /blew up/);
    assert.doesNotMatch(body, /problems/);
    // Still the container's answer, and still driven by the same field.
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().ok, false);
  });
});

// CI parses this one by name.
test('healthz still carries the timezone', async () => {
  await withServer(async (app) => {
    assert.equal((await app.inject({ method: 'GET', url: '/healthz' })).json().timezone, config.timezone);
  });
});

// The token sits in the URL path, so request logging would write it to disk on
// every poll. Fastify's serializer emits no headers, so `req.url` is the one
// that has to work.
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

// --- The status page -------------------------------------------------------

test('the status page is served to the right token as HTML', async () => {
  await withServer(async (app) => {
    const res = await app.inject({ method: 'GET', url: `/${TOKEN}/status` });

    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['content-type'], 'text/html; charset=utf-8');
    assert.ok(res.body.startsWith('<!doctype html>'));
    assert.ok(res.body.includes('simkl-ical'));
  });
});

// The page is inert by design, and these are what keep an escaping bug from
// executing and the token in the URL from leaving in a Referer header.
test('the status page carries its hardening headers', async () => {
  await withServer(async (app) => {
    const { headers } = await app.inject({ method: 'GET', url: `/${TOKEN}/status` });

    assert.match(String(headers['content-security-policy']), /default-src 'none'/);
    assert.ok(!String(headers['content-security-policy']).includes('script-src'), 'no script source is permitted at all');
    assert.equal(headers['referrer-policy'], 'no-referrer');
    assert.equal(headers['x-content-type-options'], 'nosniff');
    assert.equal(headers['cache-control'], 'private, no-store');
  });
});

// The URL bar already has it; a copy in the DOM is one more thing a screenshot
// or an extension can carry off.
test('the status page never prints the token or the spreadsheet id', async () => {
  await withConfig({ sheetId: 'SECRET-SHEET-ID' }, async () => {
    await withServer(async (app) => {
      const res = await app.inject({ method: 'GET', url: `/${TOKEN}/status` });
      assert.ok(!res.body.includes(TOKEN), 'not the feed token');
      assert.ok(!res.body.includes('SECRET-SHEET-ID'), 'and not the spreadsheet id');
    });
  });
});

test('a token of the wrong length is a 404 on the status page too, not a 500', async () => {
  await withServer(async (app) => {
    for (const wrong of ['', 'a', 'a'.repeat(47), 'a'.repeat(49)]) {
      assert.equal((await app.inject({ method: 'GET', url: `/${wrong}/status` })).statusCode, 404, `length ${wrong.length}`);
    }
  });
});

test('with no token configured the status page is unreachable', async () => {
  await withServer(
    async (app) => {
      assert.equal((await app.inject({ method: 'GET', url: `/${TOKEN}/status` })).statusCode, 404);
    },
    { token: null },
  );
});
