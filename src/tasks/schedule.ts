// When a task runs. Daily, weekly and once times are local times in the process's time zone, which is the
// owner's (TZ, Asia/Taipei in the container): JavaScript's local Date methods already apply the zone and its
// daylight-saving changes, so no library is needed. Interval times are elapsed hours and keep their cadence.

import type { Schedule } from "../api/schema.ts";

const HOUR_MS = 3_600_000;
/** A run missed by at most this long still runs; an older miss is skipped. */
export const MISSED_RUN_MS = 6 * HOUR_MS;
/** The most occurrences one occurrencesBetween call returns: a guard against a runaway loop, not a limit the owner sees. */
const MAX_OCCURRENCES = 1000;

/**
 * The first scheduled time strictly after `after`, or undefined when there is none (a one-time task whose time
 * has passed). For an interval, `previous` is the occurrence the cadence counts from: the first
 * previous + k × hours (k ≥ 1) after `after`. Without it, the next time is after + hours.
 */
export function nextOccurrence(schedule: Schedule, after: Date, previous?: Date): Date | undefined {
  switch (schedule.kind) {
    case "once": {
      const at = new Date(schedule.at);
      return at > after ? at : undefined;
    }
    case "daily":
      return nextLocalTime(after, schedule.time, () => true);
    case "weekly": {
      const days = schedule.days;
      return nextLocalTime(after, schedule.time, (weekday) => days.includes(weekday));
    }
    case "interval": {
      const step = schedule.hours * HOUR_MS;
      if (previous === undefined) return new Date(after.getTime() + step);
      const k = Math.max(1, Math.floor((after.getTime() - previous.getTime()) / step) + 1);
      return new Date(previous.getTime() + k * step);
    }
  }
}

/** The scheduled times in (from, to], oldest first, at most MAX_OCCURRENCES of them. */
export function occurrencesBetween(schedule: Schedule, from: Date, to: Date, previous?: Date): Date[] {
  const times: Date[] = [];
  let at = nextOccurrence(schedule, from, previous);
  while (at !== undefined && at <= to && times.length < MAX_OCCURRENCES) {
    times.push(at);
    at = nextOccurrence(schedule, at, previous);
  }
  return times;
}

/**
 * The first local HH:MM after `after` on a day that `onDay` accepts (weekday 1 is Monday, 7 is Sunday). Days are
 * counted on the calendar, so a daylight-saving change does not move the time of day. A time that does not exist
 * on its day comes out where Date puts it; one that occurs twice gives its first instance.
 */
function nextLocalTime(after: Date, time: string, onDay: (weekday: number) => boolean): Date | undefined {
  const hours = Number(time.slice(0, 2));
  const minutes = Number(time.slice(3, 5));
  const year = after.getFullYear();
  const month = after.getMonth();
  const day = after.getDate();
  // Eight consecutive days cover every weekday; a daily time is found the next day.
  for (let offset = 0; offset <= 7; offset++) {
    const candidate = new Date(year, month, day + offset, hours, minutes);
    const weekday = candidate.getDay() === 0 ? 7 : candidate.getDay();
    if (candidate > after && onDay(weekday)) return candidate;
  }
  return undefined;
}
