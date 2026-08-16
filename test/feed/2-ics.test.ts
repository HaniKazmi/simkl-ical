import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderIcs } from '../../src/feed/2-ics.ts';
import type { FeedEvent } from '../../src/feed/1-join.ts';

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

// The link belongs to the URL property; repeating it in DESCRIPTION adds
// length and no information.
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

// An event with nothing to describe must omit the property, not send it empty.
test('an event with nothing to describe omits DESCRIPTION entirely', () => {
  const bare: FeedEvent = { ...event, episodeTitle: null, detail: null, runtime: null };
  const ics = renderIcs([bare]);
  assert.ok(!/DESCRIPTION/.test(ics), ics);
  assert.match(ics, /SUMMARY:/, 'the rest of the event is still there');
});

test('a partial description still renders', () => {
  const ics = renderIcs([{ ...event, episodeTitle: null, runtime: null }]);
  assert.match(ics, /DESCRIPTION:FOX/);
});

test('the calendar name and timezone hint are configurable', () => {
  const ics = renderIcs([event], { name: 'My Feed', timezone: 'America/New_York' });
  assert.match(ics, /X-WR-CALNAME:My Feed/);
  assert.match(ics, /X-WR-TIMEZONE:America\/New_York/);
});

test('an event with no url omits the URL property', () => {
  assert.ok(!/^URL/m.test(renderIcs([{ ...event, url: null }])));
});

/**
 * ical-generator picks its date branch by duck-typing — a `PlainDate` is
 * recognised by having `toPlainDateTime` and lacking `hour`, `timeZoneId` and
 * `epochSeconds` — so which branch a value takes is not pinned by any type.
 *
 * That matters less than it looks: passing `start.toString()` instead routes
 * through the string branch and yields byte-identical output, so a tightened
 * check upstream would be harmless. What this asserts is the property that has
 * to hold whichever branch runs. A DATE-VALUE that became a DATE-TIME, or an
 * all-day event that acquired a time, are both silent from the calendar's point
 * of view until an event lands on the wrong day.
 */
test('an all-day event renders as a bare DATE, with the exclusive end date', () => {
  const ics = renderIcs([{ ...event, date: '2026-08-16' }]);
  assert.match(ics, /^DTSTART;VALUE=DATE:20260816\r$/m);
  assert.match(ics, /^DTEND;VALUE=DATE:20260817\r$/m);
  assert.doesNotMatch(ics, /DTSTART[^\r]*T\d{6}/, 'never a DATE-TIME');
});

// Month and year rollover, which is where `Date.UTC(y, m - 1, d + 1)` and
// `PlainDate.add({ days: 1 })` could disagree and nothing else would notice.
test('the exclusive end rolls over the month and the year', () => {
  assert.match(renderIcs([{ ...event, date: '2026-02-28' }]), /^DTEND;VALUE=DATE:20260301\r$/m);
  assert.match(renderIcs([{ ...event, date: '2026-12-31' }]), /^DTEND;VALUE=DATE:20270101\r$/m);
});
