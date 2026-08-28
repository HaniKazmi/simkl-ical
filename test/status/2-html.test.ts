import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, html, raw, renderPage, toHtml } from '../../src/status/2-html.ts';
import { buildModel } from '../../src/status/1-model.ts';
import { MINUTE, before, countsWith, input, moved, request, type InputOver } from './fixtures.ts';

test('escapeHtml covers every character that can break out of markup', () => {
  assert.equal(escapeHtml(`<script>"x" & 'y'</script>`), '&lt;script&gt;&quot;x&quot; &amp; &#39;y&#39;&lt;/script&gt;');
});

// A chained `.replace('<').replace('&')` turns `&lt;` into `&amp;lt;`, which
// renders the escape itself on the page. One pass over a class cannot.
test('escapeHtml does not double-escape its own output', () => {
  assert.equal(escapeHtml(escapeHtml('<a>')), '&amp;lt;a&amp;gt;');
  assert.equal(escapeHtml('&amp;'), '&amp;amp;');
});

// Exact, not a substring hunt: the payload's own text survives as text, which
// is the point — `onerror=alert(1)` is inert once no tag can form around it.
test('interpolated values are escaped', () => {
  const title = '<img src=x onerror=alert(1)>';
  assert.equal(toHtml(html`<td>${title}</td>`), '<td>&lt;img src=x onerror=alert(1)&gt;</td>');
});

// The property that actually matters, asserted structurally: whatever a title
// contains, the only tags in the output are the ones this file wrote.
test('no interpolated value can open a tag', () => {
  const hostile = `</td><script>alert(1)</script><td onmouseover="x">`;
  const rendered = toHtml(html`<tr><td>${hostile}</td></tr>`);
  assert.deepEqual(rendered.match(/<[^>]*>/g), ['<tr>', '<td>', '</td>', '</tr>']);
});

// The whole reason the brand is a module-private Symbol. A plain object shape
// is forgeable by anything — including a value parsed out of the run journal,
// which is a file on disk that a page renders verbatim.
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

// An unset timestamp is the common case on a cold page, and printing the word
// "null" into the markup is how a first-boot page looks broken.
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

// The fresh-container page, which is also what the CI smoke test fetches.
test('the cold page is a complete document with nothing missing rendered as text', () => {
  const rendered = page();
  assert.ok(rendered.startsWith('<!doctype html>'));
  assert.ok(rendered.includes('</html>'));
  for (const leak of ['undefined', 'NaN', '[object Object]', 'null<', '>null']) {
    assert.ok(!rendered.includes(leak), `a cold page must not print ${leak}`);
  }
});

// The realistic path: a show title lands in the run journal, which is a file on
// disk, and the page renders it on every request from then on.
test('hostile content from every untrusted source renders inert', () => {
  const payload = `</td></tr><script>alert(1)</script><img src=x onerror="alert(2)">`;
  const rendered = page({
    problems: [payload],
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
    ],
  });

  // Structural, not a substring hunt: `onerror=` legitimately survives as
  // escaped *text*, which is inert. What must not exist is a tag the payload
  // opened, so check the set of element names the document actually contains.
  const elements = new Set([...rendered.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)/g)].map((m) => m[1]!.toLowerCase()));
  assert.ok(!elements.has('script'), 'no script element');
  assert.ok(!elements.has('img'), 'no injected element');
  assert.deepEqual(
    [...elements].filter((e) => !['html', 'head', 'meta', 'title', 'style', 'body', 'div', 'header', 'h1', 'span', 'section', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'time', 'ul', 'li', 'p', 'b', 'br', 'footer'].includes(e)),
    [],
    'every element is one this file wrote',
  );
  assert.ok(rendered.includes('&lt;script&gt;'), 'and the text itself is still shown, escaped');
});

// A page that omits the section is a page that hides the one failure the
// subsystem exists to survive.
test('a frozen sheet prints the whole repair message', () => {
  const message = 'FROZEN: copy _sync-repair-1 back over Sheet1 and delete rows 610-611';
  const rendered = page({ sheetConfigured: true, sheetStatus: 'frozen', sheetFrozen: message });
  assert.ok(rendered.includes(message));
});

test('an unconfigured sheet says so rather than showing an empty section', () => {
  assert.ok(page().includes('Not configured'));
});

// Requests never trigger a fetch. A control that started work would break the
// invariant the whole architecture rests on, so there is nothing to submit.
test('the page is inert: no script, no form, no off-origin request', () => {
  const rendered = page({ sheetConfigured: true, counts: countsWith({ shows: { watching: 4 } }), gate: { pull: 'none', updated: 0, removed: 0 } });
  for (const forbidden of ['<script', '<form', '<button', 'http://', 'https://', 'src=']) {
    assert.ok(!rendered.includes(forbidden), `the page must contain no ${forbidden}`);
  }
});

// An upstream failure body is untrusted text of unknown shape — exactly what
// the `html` tag exists for, and now rendered in a second place.
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

// The change line is the part that says whether anything actually happened.
test('the library movement reaches the page', () => {
  const rendered = page({
    movement: moved({ at: before(MINUTE), deltas: [{ type: 'shows', status: 'watching', delta: -1 }, { type: 'shows', status: 'completed', delta: 1 }], updated: 3 }),
  });
  assert.match(rendered, /shows\/watching \u22121/);
  assert.match(rendered, /shows\/completed \+1/);
  assert.match(rendered, /3 records updated/);
});

test('the summary says when runtime lookups are off, and nothing when they work', () => {
  const off = renderPage(buildModel(input({ sheetConfigured: true, runtimesConfigured: false })));
  assert.match(off, /runtimes off/);
  const on = renderPage(buildModel(input({ sheetConfigured: true, runtimesConfigured: true })));
  assert.doesNotMatch(on, /runtimes off/, 'a page that works says nothing about it');
});
