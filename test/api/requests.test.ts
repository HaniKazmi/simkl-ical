import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clearRequests, describeUrl, recentRequests, recordRequest, type RequestRecord } from '../../src/api/requests.ts';

const record = (over: Partial<RequestRecord> = {}): RequestRecord => ({
  at: '2026-08-16T12:00:00Z',
  service: 'simkl',
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

// Bounded because this is a live view, not a session log: it has to stay small
// enough to render every request and old enough to show a pattern.
test('the log is capped, and drops the oldest', () => {
  clearRequests();
  for (let i = 0; i < 40; i += 1) recordRequest(record({ path: `/${i}` }));
  const kept = recentRequests();
  assert.equal(kept.length, 30);
  assert.equal(kept[0]?.path, '/39', 'the newest survives');
  assert.equal(kept.at(-1)?.path, '/10', 'and the oldest fall off');
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

// Every SIMKL URL carries the same three parameters. Kept, they would be
// eighty identical characters per row, pushing the part that differs off the
// end — a legibility decision, not a secrecy one.
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
