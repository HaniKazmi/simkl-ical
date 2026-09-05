import { test } from 'node:test';
import assert from 'node:assert/strict';
import { artworkModel, loadableImage, renderArtworkPage, type ArtworkModel } from '../../src/artwork/4-html.ts';
import type { ArtworkTitle } from '../../src/artwork/1-index.ts';
import { CLIENT_SCRIPT } from '../../src/artwork/client.ts';
import { ARTWORK_CSP } from '../../src/server.ts';

const NOW = Temporal.Instant.from('2026-09-05T12:00:00Z');

const title = (over: Partial<ArtworkTitle> = {}): ArtworkTitle => ({
  kind: 'movie',
  id: 1,
  providerId: 12,
  title: 'Finding Nemo',
  row: 4,
  address: 'N5',
  cell: { kind: 'blank', url: null, previous: {} },
  key: 'Finding Nemo',
  stored: { exists: false, updated: null },
  state: 'unlinked',
  addedBySync: null,
  lastWatchedAt: null,
  recentAt: null,
  context: null,
  franchise: 'Pixar',
  releasedOn: Temporal.PlainDate.from('2003-10-10'),
  ...over,
});

const summary = { total: 1, needing: 1, adoptable: 0, addedRecently: 0, noId: 0, shows: 0, films: 1 };

const model = (titles: ArtworkTitle[], over: Partial<ArtworkModel> = {}): ArtworkModel => ({
  ...artworkModel(
    { titles, summary, errors: [], builtAt: NOW.subtract({ minutes: 3 }) },
    { now: NOW, timezone: 'Europe/London', recentWindow: Temporal.Duration.from({ days: 30 }), appName: 'simkl-ical', version: '0.2.0', mode: 'apply', buckets: { movie: 'movies', show: 'shows' } },
  ),
  ...over,
});

const page = (titles: ArtworkTitle[], over: Partial<ArtworkModel> = {}): string => renderArtworkPage(model(titles, over));

// Titles, cells and upstream errors all reach the page; one hostile value
// through every slot must come out inert.
test('a hostile title, context and error render inert', () => {
  const evil = `"><img src=x onerror=alert(1)><script>alert(2)</script>`;
  const rendered = page([title({ title: evil, context: evil, franchise: evil })], { errors: [evil] });
  assert.ok(!rendered.includes('<script>alert'), 'no script tag opened');
  assert.ok(!/<img[^>]*onerror/.test(rendered), 'no attribute escaped its quotes');
  assert.match(rendered, /&lt;script&gt;alert\(2\)/);
  // The one <img> is the dialog's, with no src; the hostile row has a blank cell and a placeholder.
  assert.deepEqual(rendered.match(/<img [^>]*>/g), ['<img alt="" data-dialog-image>']);
});

test('the one script is the page\'s own, and it builds no markup from data', () => {
  const rendered = page([title()]);
  const scripts = [...rendered.matchAll(/<script[^>]*>/g)].map((m) => m[0]);
  assert.deepEqual(scripts, ['<script src="artwork/app.js">']);
  assert.ok(!CLIENT_SCRIPT.includes('innerHTML'), 'the client never sets innerHTML');
  assert.ok(!CLIENT_SCRIPT.includes('insertAdjacentHTML'));
  assert.ok(!/\bon[a-z]+="/.test(rendered), 'no inline handlers');
  assert.ok(!/eval\(|new Function/.test(CLIENT_SCRIPT));
});

// Every request the page makes is relative, so the token never appears in
// the page; the images it does load come from the hosts the CSP names.
test('every src and href is relative, or on one of the image hosts the CSP names', () => {
  const rendered = page([
    title({ cell: { kind: 'bucket', url: 'https://storage.googleapis.com/movies/Finding Nemo', previous: {} }, stored: { exists: true, updated: null }, state: 'done' }),
    title({ id: 2, title: 'Old', cell: { kind: 'foreign', url: 'https://image.tmdb.org/t/p/w1280/x.jpg', previous: {} }, state: 'adopt' }),
    title({ id: 3, title: 'Proxy', cell: { kind: 'foreign', url: 'https://wsrv.nl/?url=x', previous: {} }, state: 'adopt' }),
    title({ id: 4, title: 'Plain', cell: { kind: 'foreign', url: 'http://example.com/x.jpg', previous: {} }, state: 'unrecognised' }),
  ]);
  for (const match of rendered.matchAll(/(?:src|href)="([^"]+)"/g)) {
    const url = match[1] ?? '';
    if (/^[a-z]+:/.test(url)) assert.match(url, /^https:\/\//, url);
  }
  assert.ok(rendered.includes('src="https://wsrv.nl/?url=x"'), 'any https image is shown');
  assert.ok(!rendered.includes('src="http://example.com'), 'an http one, which the CSP would block, is not attempted');
  assert.ok(rendered.includes('href="status"'), 'the status page is linked relatively');
  assert.equal(loadableImage('http://wsrv.nl/x'), false);
  assert.equal(loadableImage('https://storage.googleapis.com/b/k'), true);
});

test('a bucket link with nothing behind it renders a placeholder, not a broken image', () => {
  const rendered = page([title({ cell: { kind: 'bucket', url: 'https://storage.googleapis.com/movies/Finding Nemo', previous: {} }, stored: { exists: false, updated: null }, state: 'missing-object' })]);
  assert.ok(!rendered.includes('storage.googleapis.com/movies/Finding Nemo'));
  assert.match(rendered, /class="ph"/);
  assert.match(rendered, /no object yet/);
});

test('rows carry what the client filters on, and the relative labels read from the clock', () => {
  const rendered = page([
    title({ addedBySync: NOW.subtract({ hours: 49 }), recentAt: NOW.subtract({ hours: 49 }) }),
    title({ id: 2, kind: 'show', title: 'Severance', context: 'Watching', state: 'no-id', lastWatchedAt: NOW.subtract({ hours: 3 }), recentAt: NOW.subtract({ hours: 3 }) }),
  ]);
  assert.match(rendered, /data-kind="movie" data-id="1" data-state="unlinked" data-title="Finding Nemo" data-recent="1" data-franchise="Pixar" data-released="2003-10-10" data-q="finding nemo pixar "/);
  assert.match(rendered, /<b>2d 1h ago<\/b>added by the sync/);
  assert.match(rendered, /<b>3h ago<\/b>watched/);
  assert.match(rendered, /data-kind="show" data-id="2" data-state="no-id"/);
  assert.match(rendered, /read 3m ago/);
  // A row with no usable id gets no button.
  assert.equal((rendered.match(/data-choose/g) ?? []).length, 1);
});

test('a mode other than apply is said on the page', () => {
  assert.match(page([title()], { mode: 'report' }), /Sheet mode is <span class="mono">report<\/span>/);
  assert.ok(!page([title()]).includes('Sheet mode is'));
});

// The CSP's img-src, the renderer's check and the script's check all say the
// same thing: any https URL. Pinned so one cannot tighten without the others.
test('the CSP, the page and the script agree that an image may be any https URL', () => {
  assert.match(ARTWORK_CSP, /img-src 'self' https:;/);
  assert.ok(CLIENT_SCRIPT.includes("new URL(url).protocol === 'https:'"), 'the script checks the scheme and nothing else');
  assert.equal(loadableImage('https://anything.example/x'), true);
  assert.equal(loadableImage('http://anything.example/x'), false);
});
