import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildServer } from '../src/server.ts';
import { Orchestrator } from '../src/orchestrator.ts';
import { config } from '../src/shared/config.ts';
import { quiet } from './helpers.ts';
import { nowIso } from '../src/shared/dates.ts';

const withServer = async (fn: (app: ReturnType<typeof buildServer>, state: Orchestrator) => Promise<void>): Promise<void> => {
  const state = new Orchestrator({ logger: quiet });
  const app = buildServer(state, { logger: false });
  try {
    await fn(app, state);
  } finally {
    await app.close();
  }
};

test('the feed is served as a calendar', async () => {
  await withServer(async (app, state) => {
    const res = await app.inject({ method: 'GET', url: `/feed.ics` });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['content-type'], 'text/calendar; charset=utf-8');
    assert.match(String(res.headers['content-disposition']), /filename="simkl\.ics"/);
    assert.equal(res.headers['cache-control'], 'private, no-store');
    assert.equal(res.body, state.feed.ics);
  });
});

// The pages name their icons document-relative, so they have to answer beside the pages.
test('the icons are served beside the pages', async () => {
  await withServer(async (app) => {
    const expected = [
      ['favicon.svg', 'image/svg+xml'],
      ['favicon.ico', 'image/x-icon'],
      ['apple-touch-icon.png', 'image/png'],
    ] as const;

    for (const [name, type] of expected) {
      const ok = await app.inject({ method: 'GET', url: `/${name}` });
      assert.equal(ok.statusCode, 200, name);
      assert.match(ok.headers['content-type'] as string, new RegExp(type.replace('+', '\\+')), name);
      assert.ok(ok.rawPayload.length > 0, `${name} has a body`);
    }
  });
});

// The page names its icons, so the header that would stop a browser fetching them has to admit
// them — and admit nothing else, so an injected `<img>` has nowhere off-host to load from.
test('the status CSP admits the icons and only same-origin ones', async () => {
  await withServer(async (app) => {
    const res = await app.inject({ method: 'GET', url: `/status` });
    const csp = res.headers['content-security-policy'] as string;
    assert.match(csp, /(^|;\s*)img-src 'self'(;|$)/, 'same-origin images only');
    assert.match(csp, /default-src 'none'/, 'everything else still denied by default');
    assert.ok(!csp.includes('script-src'), 'no script source is granted');
    assert.equal(res.headers['referrer-policy'], 'no-referrer');
  });
});

test('healthz is 503 until a render has happened, and 200 after', async () => {
  await withServer(async (app, state) => {
    const before = await app.inject({ method: 'GET', url: '/healthz' });
    assert.equal(before.statusCode, 503);
    assert.equal(before.json().ok, false);

    state.feed.renderedAt = nowIso();
    state.feed.calendarsFreshAt = nowIso();
    state.polledAt = nowIso();

    const after = await app.inject({ method: 'GET', url: '/healthz' });
    assert.equal(after.statusCode, 200);
    assert.equal(after.json().ok, true);
  });
});

test('healthz answers before anything has rendered', async () => {
  await withServer(async (app) => {
    assert.equal((await app.inject({ method: 'GET', url: '/healthz' })).statusCode, 503);
  });
});

// The key set is a contract: CI parses this body, and so does anything an
// operator points at it. tsc never checks key order and `JSON.stringify`
// emits insertion order, so only an assertion holds the shape.
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

// Diagnostics are the status page's job: free text in a healthcheck is
// wording that changes, in a body a machine parses.
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

// --- The status page -------------------------------------------------------

test('the status page is served as HTML', async () => {
  await withServer(async (app) => {
    const res = await app.inject({ method: 'GET', url: `/status` });

    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['content-type'], 'text/html; charset=utf-8');
    assert.ok(res.body.startsWith('<!doctype html>'));
    assert.ok(res.body.includes('simkl-ical'));
  });
});

// These keep an escaping bug in an interpolated title or error from executing.
test('the status page carries its hardening headers', async () => {
  await withServer(async (app) => {
    const { headers } = await app.inject({ method: 'GET', url: `/status` });

    assert.match(String(headers['content-security-policy']), /default-src 'none'/);
    assert.ok(!String(headers['content-security-policy']).includes('script-src'), 'no script source is permitted at all');
    assert.equal(headers['referrer-policy'], 'no-referrer');
    assert.equal(headers['x-content-type-options'], 'nosniff');
    assert.equal(headers['cache-control'], 'private, no-store');
  });
});

// Both feed addresses are built from the request, because nothing else knows
// the public origin — and `webcal:` needs a full authority, so unlike the rest
// of the page this one is a click target and not only text.
test('the feed links follow the host the reader arrived on', async () => {
  await withServer(async (app) => {
    const res = await app.inject({
      method: 'GET',
      url: `/status`,
      headers: { host: 'simkl.hani.fyi', 'x-forwarded-proto': 'https' },
    });
    assert.ok(res.body.includes(`href="webcal://simkl.hani.fyi/feed.ics"`), 'clicking it subscribes');
    assert.ok(res.body.includes(`title="https://simkl.hani.fyi/feed.ics"`), 'and the https form is there to paste');
  });
});

// The scheme is client-settable and lands in an `href`. Anything but http or
// https survives the `^https?:` rewrite unchanged, so the subscribe link would
// carry whatever was sent — `HTTPS` from a real proxy is the same defect.
test('a scheme the page did not choose never reaches the link', async () => {
  await withServer(async (app) => {
    for (const claimed of ['javascript', 'ftp', 'HTTPS', 'https evil']) {
      const res = await app.inject({
        method: 'GET',
        url: `/status`,
        headers: { host: 'simkl.hani.fyi', 'x-forwarded-proto': claimed },
      });
      const hrefs = [...res.body.matchAll(/<a [^>]*href="([^"]*)"/g)].map((m) => m[1]!);
      for (const href of hrefs) {
        assert.match(href, /^(webcal|https):/, `${claimed} produced ${href}`);
      }
    }
  });
});

// `x-forwarded-proto: https` is the only way to know a proxy terminated TLS,
// so the honest value still has to win over the connection's own scheme.
test('a proxy that terminated TLS is believed', async () => {
  await withServer(async (app) => {
    const res = await app.inject({
      method: 'GET',
      url: `/status`,
      headers: { host: 'simkl.hani.fyi', 'x-forwarded-proto': 'https' },
    });
    assert.ok(res.body.includes(`title="https://simkl.hani.fyi/feed.ics"`));
  });
});
