import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderIcs } from '../src/ics.ts';
import type { FeedEvent } from '../src/join.ts';

const event: FeedEvent = {
  uid: 'simkl-3407-s11e03@simkl-ical',
  kind: 'tv',
  date: '2026-08-10',
  summary: 'Futurama – S11E03',
  episodeTitle: 'Our Flag Means Medical Coverage',
  detail: 'FOX',
  runtime: '23m',
  url: 'https://simkl.com/tv/3407/futurama/season-11/episode-3/',
};

test('all-day events use DATE values with an exclusive DTEND', () => {
  const ics = renderIcs([event]);
  assert.match(ics, /DTSTART;VALUE=DATE:20260810/);
  assert.match(ics, /DTEND;VALUE=DATE:20260811/);
});

test('UIDs are derived, so re-rendering updates rather than duplicates', () => {
  const first = renderIcs([event]);
  const second = renderIcs([event]);
  const uidOf = (ics: string) => ics.match(/UID:(.+)/)![1]!.trim();
  assert.equal(uidOf(first), uidOf(second));
  assert.equal(uidOf(first), 'simkl-3407-s11e03@simkl-ical');
});

test('DTSTAMP is UTC with a Z suffix, as RFC 5545 requires', () => {
  const ics = renderIcs([event]);
  assert.match(ics, /DTSTAMP:\d{8}T\d{6}Z/);
});

test('episode title is in the description, never the summary', () => {
  const ics = renderIcs([event]);
  assert.match(ics, /SUMMARY:Futurama – S11E03/);
  assert.ok(!/SUMMARY:.*Our Flag/.test(ics));
  assert.match(ics, /Our Flag Means Medical Coverage/);
});

// The link belongs to the URL property; repeating it in DESCRIPTION just makes
// every event's body longer for no added information.
test('the simkl link is a URL property, not duplicated into the description', () => {
  const ics = renderIcs([event]).replace(/\r\n /g, '');
  assert.match(ics, /URL;VALUE=URI:https:\/\/simkl\.com\/tv\/3407/);

  const body = ics.match(/DESCRIPTION:(.*)/)![1]!;
  assert.ok(!body.includes('simkl.com'), `description still carries the link: ${body}`);
  assert.match(body, /Our Flag Means Medical Coverage/);
  assert.match(body, /FOX · 23m/);
});

test('lines are folded to 75 octets and terminated with CRLF', () => {
  const ics = renderIcs([{ ...event, episodeTitle: 'A'.repeat(300) }]);
  assert.ok(ics.includes('\r\n'));
  for (const line of ics.split('\r\n')) {
    assert.ok(Buffer.byteLength(line) <= 75, `line too long: ${line.length}`);
  }
});

test('special characters in titles are escaped', () => {
  const ics = renderIcs([{ ...event, summary: 'Show; with, punctuation' }]);
  assert.match(ics, /SUMMARY:Show\\; with\\, punctuation/);
});

test('airdates are transparent so they do not mark the user busy', () => {
  assert.match(renderIcs([event]), /TRANSP:TRANSPARENT/);
});

test('an empty feed is still a valid calendar', () => {
  const ics = renderIcs([]);
  assert.match(ics, /BEGIN:VCALENDAR/);
  assert.match(ics, /END:VCALENDAR/);
  assert.ok(!ics.includes('BEGIN:VEVENT'));
});
