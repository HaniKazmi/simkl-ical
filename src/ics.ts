import ical, { ICalCalendarMethod, ICalEventTransparency } from 'ical-generator';
import { config } from './config.ts';
import type { FeedEvent } from './join.ts';

/** YYYY-MM-DD -> Date at UTC midnight, for all-day events. */
const dateOnly = (ymd: string, addDays = 0): Date => {
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + addDays));
};

/**
 * Episode titles stay out of SUMMARY — a calendar surfaces those without the
 * user choosing to look, and they occasionally spoil. The simkl.com link is not
 * repeated here either; it is already the event's URL property.
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
    // DTSTAMP, which RFC 5545 requires in UTC. Every event here is all-day, so
    // only the X-WR-TIMEZONE hint is lost, and that is added back below.
    ttl: 6 * 60 * 60,
    method: ICalCalendarMethod.PUBLISH,
  });

  // Hints only. Google ignores these and polls on its own schedule, commonly
  // 8-24h; Apple Calendar honours a user-set interval.
  cal.x('X-WR-TIMEZONE', timezone);

  for (const event of events) {
    cal.createEvent({
      id: event.uid,
      start: dateOnly(event.date),
      end: dateOnly(event.date, 1), // DTEND is exclusive for all-day events
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
