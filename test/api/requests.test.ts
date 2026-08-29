import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clearRequests, describeUrl, recentRequests, recordRequest, type RequestRecord } from '../../src/api/requests.ts';

const record = (over: Partial<RequestRecord> = {}): RequestRecord => ({
  at: '2026-08-16T12:00:00Z',
  service: 'simkl',
  component: 'poll',
  method: 'GET',
  path: '/sync/activities',
  status: 200,
  ms: 120,
  bytes: 1100,
  attempts: 1,
  error: null,
  ...over,
});

test('the newest request is first, because that is the order it is read in', () => {
  clearRequests();
  recordRequest(record({ path: '/first' }));
  recordRequest(record({ path: '/second' }));
  assert.deepEqual(
    recentRequests().map((r) => r.path),
    ['/second', '/first'],
  );
});

// A live view, not a session log: small enough to render every request, old
// enough to show a pattern.
test('the log is capped, and drops the oldest of that component', () => {
  clearRequests();
  for (let i = 0; i < 40; i += 1) recordRequest(record({ path: `/${i}` }));
  const kept = recentRequests();
  assert.equal(kept.length, 8);
  assert.equal(kept[0]?.path, '/39', 'the newest survives');
  assert.equal(kept.at(-1)?.path, '/32', 'and the oldest fall off');
});

// A cold start looks up every due film in one pass, so under one shared ring
// the two rows proving the delta sync works are evicted before anyone loads
// the page.
test('a burst on one component cannot evict another', () => {
  clearRequests();
  recordRequest(record({ component: 'poll', path: '/sync/activities' }));
  recordRequest(record({ component: 'poll', path: '/sync/all-items?date_from=x' }));
  for (let i = 0; i < 300; i += 1) recordRequest(record({ component: 'films', path: `/movies/${i}` }));

  const polls = recentRequests().filter((r) => r.component === 'poll');
  assert.deepEqual(
    polls.map((r) => r.path),
    ['/sync/all-items?date_from=x', '/sync/activities'],
    'both poll rows survive 300 film lookups',
  );
  assert.equal(recentRequests().filter((r) => r.component === 'films').length, 8);
});

// One array, not a map of six: a delta landing between two film lookups says
// the poll did more than one thing, and only the interleaving shows it.
test('the log keeps components interleaved in time order', () => {
  clearRequests();
  recordRequest(record({ component: 'films', path: '/movies/1' }));
  recordRequest(record({ component: 'poll', path: '/sync/activities' }));
  recordRequest(record({ component: 'films', path: '/movies/2' }));
  assert.deepEqual(
    recentRequests().map((r) => r.path),
    ['/movies/2', '/sync/activities', '/movies/1'],
  );
});

test('clearing empties it', () => {
  clearRequests();
  recordRequest(record());
  clearRequests();
  assert.deepEqual(recentRequests(), []);
});

// The page renders this, and a caller iterating it must not see a poll land
// halfway through.
test('the log hands out a copy, not its own array', () => {
  clearRequests();
  recordRequest(record());
  const taken = recentRequests();
  recordRequest(record({ path: '/later' }));
  assert.equal(taken.length, 1, 'the copy is unaffected by a later call');
});

// An upstream failure body is text of unknown length and shape.
test('an error body is flattened and truncated', () => {
  clearRequests();
  recordRequest(record({ error: `${'x'.repeat(400)}\n\n   trailing` }));
  const stored = recentRequests()[0]?.error ?? '';
  assert.ok(stored.length <= 301, `expected a truncated body, got ${stored.length} chars`);
  assert.ok(stored.endsWith('…'), 'and a marker that it was cut');
});

test('a newline-ridden body renders as one line', () => {
  clearRequests();
  recordRequest(record({ error: 'first\n\nsecond\t\tthird' }));
  assert.equal(recentRequests()[0]?.error, 'first second third');
});

// --- describeUrl -----------------------------------------------------------

// Every SIMKL URL carries the same three parameters — eighty identical
// characters per row, pushing what differs off the end. A legibility decision,
// not a secrecy one.
test('the boilerplate parameters are dropped and the meaningful ones kept', () => {
  const url = 'https://api.simkl.com/sync/all-items?client_id=abc&app-name=simkl-ical&app-version=0.2.0&date_from=2026-08-15T11%3A59%3A59Z';
  assert.equal(describeUrl(url), '/sync/all-items?date_from=2026-08-15T11:59:59Z');
});

test('a path with nothing worth keeping renders bare', () => {
  assert.equal(describeUrl('https://api.simkl.com/sync/activities?client_id=abc&app-name=simkl-ical'), '/sync/activities');
});

test('the CDN path survives intact', () => {
  assert.equal(describeUrl('https://data.simkl.in/calendar/v2/tv.json'), '/calendar/v2/tv.json');
});

// The Sheets read sends a field mask that is longer than the rest of the URL.
test('the Sheets field mask is dropped but the range is kept', () => {
  const url = "https://sheets.googleapis.com/v4/spreadsheets/SID?ranges='Sheet1'&fields=sheets(properties(sheetId))";
  assert.equal(describeUrl(url), "/v4/spreadsheets/SID?ranges='Sheet1'");
});

test('something that is not a URL is passed through rather than thrown over', () => {
  assert.equal(describeUrl('not a url'), 'not a url');
});

// --- who asked, as opposed to who answered ---------------------------------

// SIMKL serves three parts of this service, so the upstream alone cannot say
// why a call happened: `/tv/1649662` is the sheet reading a catalogue,
// `/movies/174094` is the feed dating a film, and they look alike.
test('a record says which part of the service asked', () => {
  clearRequests();
  recordRequest(record({ service: 'simkl', component: 'catalogue', path: '/tv/1649662' }));
  recordRequest(record({ service: 'simkl', component: 'films', path: '/movies/174094' }));
  recordRequest(record({ service: 'simkl', component: 'poll', path: '/sync/activities' }));

  assert.deepEqual(
    recentRequests().map((r) => [r.component, r.path]),
    [
      ['poll', '/sync/activities'],
      ['films', '/movies/174094'],
      ['catalogue', '/tv/1649662'],
    ],
  );
});
