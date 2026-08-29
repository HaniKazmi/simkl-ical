/**
 * RENDER — events → an ICS string.
 *
 * Third of FETCH (io/) → JOIN → **RENDER** → SAVE. The only module that knows
 * the output format, hence `ics` in the name.
 */

import ical, { ICalCalendarMethod, ICalEventTransparency } from 'ical-generator';
import { config } from '../shared/config.ts';
import type { FeedEvent } from './2-join.ts';

/**
 * Episode titles stay out of SUMMARY — a calendar surfaces those unasked, and
 * they occasionally spoil. The simkl.com link is already the event's URL
 * property, so it is not repeated here.
 */
const description = (event: FeedEvent): string | undefined => {
  const lines: string[] = [];
  if (event.episodeTitle) lines.push(event.episodeTitle);

  const facts = [event.detail, event.runtime].filter(Boolean);
  if (facts.length) lines.push(facts.join(' · '));

  // undefined, not '', so the property is omitted rather than sent empty.
  return lines.length ? lines.join('\n') : undefined;
};

export interface RenderOptions {
  name?: string;
  timezone?: string;
}

export const renderIcs = (events: FeedEvent[], { name = 'SIMKL', timezone = config.timezone }: RenderOptions = {}): string => {
  const cal = ical({
    name,
    prodId: { company: 'simkl-ical', product: 'simkl-ical', language: 'EN' },
    // No calendar-level `timezone`: it makes ical-generator emit a floating
    // DTSTAMP, which RFC 5545 requires in UTC. Every event is all-day, so only
    // the X-WR-TIMEZONE hint is lost, and it is added back below.
    ttl: Math.round(config.calendarRefresh.total('seconds')),
    method: ICalCalendarMethod.PUBLISH,
  });

  // Hints only. Google ignores these and polls on its own schedule, commonly
  // 8-24h; Apple Calendar honours a user-set interval.
  cal.x('X-WR-TIMEZONE', timezone);

  for (const event of events) {
    // The join already resolved the zone and ical-generator accepts Temporal
    // values — no `Date` at UTC midnight is manufactured here.
    const start = event.date;
    cal.createEvent({
      id: event.uid,
      start,
      end: start.add({ days: 1 }), // DTEND is exclusive for all-day events
      allDay: true,
      summary: event.summary,
      description: description(event),
      url: event.url ?? undefined,
      // All-day airdates should never make the user look busy.
      transparency: ICalEventTransparency.TRANSPARENT,
    });
  }

  return cal.toString();
};
