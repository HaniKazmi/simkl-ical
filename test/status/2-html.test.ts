import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, html, raw, renderPage, toHtml } from '../../src/status/2-html.ts';
import { buildModel } from '../../src/status/1-model.ts';
import { MINUTE, before, countsWith, input, moved, request, runRecord, type InputOver } from './fixtures.ts';

test('escapeHtml covers every character that can break out of markup', () => {
  assert.equal(escapeHtml(`<script>"x" & 'y'</script>`), '&lt;script&gt;&quot;x&quot; &amp; &#39;y&#39;&lt;/script&gt;');
});

// A chained `.replace('<').replace('&')` turns `&lt;` into `&amp;lt;`,
// rendering the escape itself; one pass over a class cannot.
test('escapeHtml does not double-escape its own output', () => {
  assert.equal(escapeHtml(escapeHtml('<a>')), '&amp;lt;a&amp;gt;');
  assert.equal(escapeHtml('&amp;'), '&amp;amp;');
});

// Exact, not a substring hunt: the payload's text survives as text —
// `onerror=alert(1)` is inert once no tag can form around it.
test('interpolated values are escaped', () => {
  const title = '<img src=x onerror=alert(1)>';
  assert.equal(toHtml(html`<td>${title}</td>`), '<td>&lt;img src=x onerror=alert(1)&gt;</td>');
});

// Asserted structurally: whatever a title contains, the only tags in the
// output are the ones this file wrote.
test('no interpolated value can open a tag', () => {
  const hostile = `</td><script>alert(1)</script><td onmouseover="x">`;
  const rendered = toHtml(html`<tr><td>${hostile}</td></tr>`);
  assert.deepEqual(rendered.match(/<[^>]*>/g), ['<tr>', '<td>', '</td>', '</tr>']);
});

// Why the brand is a module-private Symbol: a plain object shape is forgeable
// by anything — including a value parsed out of the run journal, a file on
// disk the page renders verbatim.
test('a forged safe-html object is escaped, not trusted', () => {
  for (const forgery of [{ html: '<script>alert(1)</script>' }, { [Symbol('safe-html')]: '<script>alert(1)</script>' }, { toString: () => '<b>' }]) {
    const rendered = toHtml(html`<p>${forgery}</p>`);
    assert.ok(!rendered.includes('<script'), 'no script tag survives');
    assert.ok(!rendered.includes('<b>'), 'and neither does a bare tag');
  }
});

test('a nested html fragment passes through without double-escaping', () => {
  const inner = html`<b>${'a & b'}</b>`;
  assert.equal(toHtml(html`<td>${inner}</td>`), '<td><b>a &amp; b</b></td>');
});

test('arrays join, so a list of rows is an expression rather than a loop', () => {
  const rows = ['a', '<b>'].map((v) => html`<li>${v}</li>`);
  assert.equal(toHtml(html`<ul>${rows}</ul>`), '<ul><li>a</li><li>&lt;b&gt;</li></ul>');
});

// An unset timestamp is the common case on a cold page; printing "null" is
// how a first-boot page looks broken.
test('null and undefined render as nothing, not as their names', () => {
  assert.equal(toHtml(html`<p>${null}${undefined}</p>`), '<p></p>');
});

test('raw is the one way through, and stays opt-in', () => {
  assert.equal(toHtml(html`<style>${raw('a > b { color: red }')}</style>`), '<style>a > b { color: red }</style>');
});

test('numbers and booleans render as themselves', () => {
  assert.equal(toHtml(html`<p>${0}${false}${142}</p>`), '<p>0false142</p>');
});


// --- The page --------------------------------------------------------------

const page = (over: InputOver = {}): string => renderPage(buildModel(input(over)));

/**
 * The Sheet section alone. `details` is used nowhere else on the page, so a
 * count of zero over the whole document passes just as well on a page that
 * dropped the section entirely.
 */
const sheetSection = (rendered: string): string => {
  const from = rendered.indexOf('>Sheet</h2>');
  const to = rendered.indexOf('>Requests</h2>');
  assert.ok(from > 0 && to > from, 'the Sheet section is on the page at all');
  return rendered.slice(from, to);
};

// The fresh-container page, and what the CI smoke test fetches.
test('the cold page is a complete document with nothing missing rendered as text', () => {
  const rendered = page();
  assert.ok(rendered.startsWith('<!doctype html>'));
  assert.ok(rendered.includes('</html>'));
  for (const leak of ['undefined', 'NaN', '[object Object]', 'null<', '>null']) {
    assert.ok(!rendered.includes(leak), `a cold page must not print ${leak}`);
  }
});

// The realistic path: a show title lands in the run journal on disk, and the
// page renders it on every request from then on.
test('hostile content from every untrusted source renders inert', () => {
  const payload = `</td></tr><script>alert(1)</script><img src=x onerror="alert(2)">`;
  const rendered = page({
    problems: [{ area: 'library', message: payload }],
    libraryError: payload,
    gate: { pull: 'none', updated: 0, removed: 0 },
    sheetConfigured: true,
    sheetFrozen: `FROZEN: copy ${payload} back`,
    sheetStatus: 'frozen',
    runs: [
      {
        at: before(MINUTE),
        status: 'rolled-back',
        mode: 'apply',
        edits: [{ address: payload, field: payload as never, note: payload }],
        inserts: [{ address: payload, title: payload, season: 1, note: payload }],
        error: payload,
        repeats: 1,
      },
      // The same payload again on a run that carries no error, so it reaches
      // the summary line rather than the expanded rows. Both are journal
      // fields the page renders verbatim, and they interpolate at different
      // call sites.
      { at: before(MINUTE), status: 'applied', mode: 'apply', edits: [{ address: payload, field: payload as never, note: payload }], inserts: [], error: null, repeats: 1 },
    ],
  });

  // Structural, not a substring hunt: `onerror=` legitimately survives as
  // escaped text. What must not exist is a tag the payload opened, so check
  // the set of element names the document contains.
  const elements = new Set([...rendered.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)/g)].map((m) => m[1]!.toLowerCase()));
  assert.ok(!elements.has('script'), 'no script element');
  assert.ok(!elements.has('img'), 'no injected element');
  assert.deepEqual(
    [...elements].filter(
      (e) =>
        !['html', 'head', 'meta', 'title', 'style', 'link', 'body', 'div', 'header', 'h1', 'h2', 'span', 'section', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'time', 'ul', 'li', 'p', 'b', 'br', 'footer', 'a', 'details', 'summary'].includes(e),
    ),
    [],
    'every element is one this file wrote',
  );
  assert.ok(rendered.includes('&lt;script&gt;'), 'and the text itself is still shown, escaped');
});

// A triangle that reveals the line already shown is worse than no triangle,
// and a real history is nearly all runs of one write. Asserted on the run
// markup rather than the page's: `details` is used nowhere else, so a count of
// zero across the whole document would pass on a page that lost the section.
test('a run of one write renders flat, with the change on the line and nothing to open', () => {
  const rendered = page({
    sheetConfigured: true,
    runs: [runRecord({ edits: [{ address: 'F1052', field: 'Episode', note: 'Veep S2: 6 -> 7 episodes' }] })],
  });
  const section = sheetSection(rendered);

  assert.match(section, /Veep S2: 6 -&gt; 7 episodes/, 'the change is on the page');
  assert.match(section, /class="run-head bare sole"/, 'as the line itself');
  assert.ok(!section.includes('<details'), 'and there is nothing left to expand');
});

// The two writes an applied run most often is: the line carries both halves
// and there is still nothing behind it.
test('a count and its date render flat, on one line', () => {
  const rendered = page({
    sheetConfigured: true,
    runs: [
      runRecord({
        edits: [
          { address: 'F378', field: 'Episode', note: 'Frieren S1: 16 -> 17 episodes' },
          { address: 'B378', field: 'Status', note: 'Frieren S1: last watched 2026-09-01' },
        ],
      }),
    ],
  });
  const section = sheetSection(rendered);

  assert.match(section, /Frieren S1: 16 -&gt; 17 episodes, last watched 2026-09-01/, 'both halves on the one line');
  assert.match(section, /class="run-head bare sole"/, 'as the line itself');
  assert.ok(!section.includes('<details'), 'and there is nothing left to expand');
  assert.ok(!section.includes('B378'), 'the note\u2019s own cell is the Status column of that row, not a second place to look');
});

// Newest last in the journal, so the two-edit run here is not the open one —
// the collapse is what is under test, and the newest run never collapses.
test('a run of several writes keeps the expander it has something to reveal behind', () => {
  const rendered = page({
    sheetConfigured: true,
    runs: [
      runRecord({ at: before(2 * MINUTE), edits: [{ address: 'B2', field: 'Status', note: 'watching' }, { address: 'B3', field: 'End', note: 'ended' }] }),
      runRecord({ at: before(MINUTE) }),
    ],
  });
  const section = sheetSection(rendered);

  assert.ok(section.includes('<details'), 'the run collapses');
  assert.match(section, /2 edits/, 'and its summary says how much is behind it');
});

// Omitting the section hides the one failure the subsystem exists to survive.
test('a frozen sheet prints the whole repair message', () => {
  const message = 'FROZEN: copy _sync-repair-1 back over Sheet1 and delete rows 610-611';
  const rendered = page({ sheetConfigured: true, sheetStatus: 'frozen', sheetFrozen: message });
  assert.ok(rendered.includes(message));
});

test('an unconfigured sheet says so rather than showing an empty section', () => {
  assert.ok(page().includes('Not configured'));
});

// Requests never trigger a fetch; a control that started work would break the
// invariant the architecture rests on.
// The page loads nothing: the feed token is in its URL, and any subresource
// would carry it to another origin in a `Referer`. A link the reader clicks is
// not a subresource — `no-referrer` covers it, and the two links are the point
// of the page — so what is banned is every form of automatic fetching.
// The icons are the only thing this page asks the browser to fetch, and the point of the rule is
// not that the count is zero — it is that nothing it fetches can reach another host. The token is
// in this page's own URL, so a subresource pointed off-origin would hand it over in the request
// line; a relative one addresses the service that issued it.
test('the page fetches nothing off this host: no script, no form, no remote subresource', () => {
  const rendered = page({
    sheetConfigured: true,
    sheetUrl: 'https://docs.google.com/spreadsheets/d/SHEET/edit',
    counts: countsWith({ shows: { watching: 4 } }),
    gate: { pull: 'none' },
  });
  for (const forbidden of ['<script', '<form', '<button', '<iframe', 'src=', 'srcset', '@import', 'url(', 'http-equiv', 'ping=']) {
    assert.ok(!rendered.includes(forbidden), `the page must contain no ${forbidden}`);
  }
  // Pinned exactly, so a fourth one cannot arrive unnoticed, and every href stays relative.
  assert.deepEqual(
    [...rendered.matchAll(/<link[^>]*href="([^"]*)"/g)].map((m) => m[1]!),
    // Order is asserted, not just membership: the `.ico` leads because Safari before 26 renders
    // no SVG favicon and has to reach a raster one.
    ['favicon.ico', 'favicon.svg', 'apple-touch-icon.png'],
    'the icons are the only subresources, and all of them are same-origin',
  );
});

/** Every absolute URL in the document, whatever attribute or text it sits in. */
const urlsIn = (rendered: string): string[] => [...rendered.matchAll(/[a-z]+:\/\/[^"'\s<>]+/g)].map((m) => m[0]);

/** `webcal:` addresses the same authority; parse it as https to read the host. */
const hostOf = (url: string): string => new URL(url.replace(/^webcal:/, 'https:')).host;

// The token is in this page's own URL and in both feed links, which is fine:
// the reader already has it. What must never happen is it addressing another
// host. A `webcal:` subscription is durable — one wrong address keeps
// re-fetching with the token for as long as that calendar lives.
test('the feed token only ever addresses this service', () => {
  const rendered = page({ sheetConfigured: true, sheetUrl: 'https://docs.google.com/spreadsheets/d/SHEET/edit' });
  const carrying = urlsIn(rendered).filter((url) => url.includes('fixture-token'));

  assert.ok(carrying.length > 0, 'the feed links are on the page at all');
  for (const url of carrying) assert.equal(hostOf(url), 'localhost:3000', `${url} is not this service`);
});

test('the spreadsheet is the only host the page links out to', () => {
  const rendered = page({ sheetConfigured: true, sheetUrl: 'https://docs.google.com/spreadsheets/d/SHEET/edit' });
  const hosts = new Set([...rendered.matchAll(/<a [^>]*href="([^"]*)"/g)].map((m) => hostOf(m[1]!)));
  assert.deepEqual([...hosts].sort(), ['docs.google.com', 'localhost:3000']);
});

// Following the http address downloads a snapshot, which a client imports once
// and never refreshes. Only `webcal:` asks it to subscribe.
test('the subscribe link asks for a subscription, not a download', () => {
  const rendered = page({});
  const hrefs = [...rendered.matchAll(/<a [^>]*href="([^"]*)"/g)].map((m) => m[1]!);
  assert.ok(
    hrefs.some((href) => href.startsWith('webcal://') && href.endsWith('/feed.ics')),
    'the feed is linked as webcal',
  );
});

test('every link is safe to follow', () => {
  const rendered = page({ sheetConfigured: true, sheetUrl: 'https://docs.google.com/spreadsheets/d/SHEET/edit' });
  for (const tag of [...rendered.matchAll(/<a [^>]*>/g)].map((m) => m[0])) {
    assert.match(tag, /rel="noopener noreferrer"/, `${tag} needs rel`);
  }
});

// An upstream failure body is untrusted text of unknown shape — exactly what
// the `html` tag exists for.
test('a failing request renders its body inert', () => {
  const payload = `</td></tr><script>alert(1)</script>`;
  const rendered = page({
    requests: [request({ at: before(MINUTE), path: `/sync/activities?evil=${payload}`, status: 401, attempts: 5, error: payload })],
  });

  assert.ok(!rendered.includes('<script>'), 'the body must not open a tag');
  assert.match(rendered, /&lt;script&gt;/, 'and must still be readable, escaped');
  assert.match(rendered, /401/);
  assert.match(rendered, /×5/, 'the retries are the fact worth surfacing');
});

test('an empty request log renders the section rather than breaking the page', () => {
  const rendered = page({ requests: [] });
  assert.match(rendered, /Nothing requested yet/);
  assert.ok(!rendered.includes('undefined'));
});

test('the library movement reaches the page', () => {
  const rendered = page({
    movement: moved({ at: before(MINUTE), deltas: [{ type: 'shows', status: 'watching', delta: -1 }, { type: 'shows', status: 'completed', delta: 1 }], updated: 3 }),
  });
  assert.match(rendered, /shows\/watching \u22121/);
  assert.match(rendered, /shows\/completed \+1/);
  assert.match(rendered, /3 records read/);
  assert.match(rendered, /last pull/, 'labelled, because it is a different moment from the gate pill');
});

test('the summary says when runtime lookups are off, and nothing when they work', () => {
  const off = renderPage(buildModel(input({ sheetConfigured: true, runtimesConfigured: false })));
  assert.match(off, /runtimes off/);
  const on = renderPage(buildModel(input({ sheetConfigured: true, runtimesConfigured: true })));
  assert.doesNotMatch(on, /runtimes off/, 'a page that works says nothing about it');
});

// A stamp with no usable instant must not become a `<time>`: the attribute
// would carry the unparseable string and the tooltip would be empty.
test('an unparseable timestamp renders no time element', () => {
  const rendered = page({ polledAt: 'not a date' });
  assert.ok(!rendered.includes('datetime="not a date"'), 'no invalid datetime attribute');
  assert.ok(!rendered.includes('title=""'), 'and no empty tooltip');
});

/**
 * The record is otherwise invisible: its first run records everything and
 * writes nothing, which reaches the history as an `idle` run with no edits —
 * the same thing a sync that never armed produces. This line is what tells
 * "armed and quiet" from "not running" during a rollout.
 */
test('the summary says how much the sync is tracking, and says so when it is nothing', () => {
  const cold = sheetSection(page({ sheetConfigured: true }));
  assert.match(cold, /nothing tracked yet/);

  const armed = sheetSection(page({ sheetConfigured: true, baseline: { seasons: 412, at: '2026-08-30T09:00:00.000Z' } }));
  assert.match(armed, /tracking <b class="mono">412<\/b> seasons/);
  assert.match(armed, /last moved/);
  assert.doesNotMatch(armed, /nothing tracked yet/);
});
