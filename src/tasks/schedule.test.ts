import assert from "node:assert/strict";
import { test } from "node:test";

import type { Schedule } from "../api/schema.ts";

// Schedules are local times: pin the zone before any date is made, so the result does not depend on the machine.
process.env.TZ = "Asia/Taipei";

const { nextOccurrence, occurrencesBetween } = await import("./schedule.ts");

const at = (iso: string) => new Date(iso);

test("a daily time is the next one strictly after the given moment", () => {
  const daily: Schedule = { kind: "daily", time: "08:00" };
  assert.deepEqual(nextOccurrence(daily, at("2026-10-26T07:59:00+08:00")), at("2026-10-26T08:00:00+08:00"));
  assert.deepEqual(nextOccurrence(daily, at("2026-10-26T08:00:00+08:00")), at("2026-10-27T08:00:00+08:00"), "the time itself is not after itself");
  assert.deepEqual(nextOccurrence(daily, at("2026-10-26T09:30:00+08:00")), at("2026-10-27T08:00:00+08:00"));
  assert.deepEqual(nextOccurrence(daily, at("2026-12-31T23:59:00+08:00")), at("2027-01-01T08:00:00+08:00"), "across the year's end");
});

test("a weekly time runs on its weekdays, across the week's end too", () => {
  const monWed: Schedule = { kind: "weekly", days: [1, 3], time: "08:00" };
  assert.deepEqual(nextOccurrence(monWed, at("2026-10-25T20:00:00+08:00")), at("2026-10-26T08:00:00+08:00"), "Sunday night to Monday");
  assert.deepEqual(nextOccurrence(monWed, at("2026-10-26T09:00:00+08:00")), at("2026-10-28T08:00:00+08:00"), "Monday to Wednesday");
  assert.deepEqual(nextOccurrence(monWed, at("2026-10-28T08:00:00+08:00")), at("2026-11-02T08:00:00+08:00"), "from Wednesday's time to next Monday");
  const sunday: Schedule = { kind: "weekly", days: [7], time: "06:00" };
  assert.deepEqual(nextOccurrence(sunday, at("2026-10-26T00:00:00+08:00")), at("2026-11-01T06:00:00+08:00"));
});

test("an interval counts elapsed hours from now, or from the previous occurrence when it has one", () => {
  const sixHours: Schedule = { kind: "interval", hours: 6 };
  assert.deepEqual(nextOccurrence(sixHours, at("2026-10-26T10:00:00+08:00")), at("2026-10-26T16:00:00+08:00"), "no previous: after plus hours");
  const from0800 = at("2026-10-26T08:00:00+08:00");
  assert.deepEqual(nextOccurrence(sixHours, at("2026-10-26T10:00:00+08:00"), from0800), at("2026-10-26T14:00:00+08:00"), "previous plus 6h, not 10:00 plus 6h");
  assert.deepEqual(nextOccurrence(sixHours, at("2026-10-26T14:00:00+08:00"), from0800), at("2026-10-26T20:00:00+08:00"), "an occurrence is not after itself");
  assert.deepEqual(nextOccurrence(sixHours, at("2026-10-26T21:00:00+08:00"), from0800), at("2026-10-27T02:00:00+08:00"), "occurrences already past are skipped");
  const everyDay: Schedule = { kind: "interval", hours: 24 };
  assert.deepEqual(nextOccurrence(everyDay, at("2026-10-26T12:00:00+08:00"), at("2026-10-01T00:00:00+08:00")), at("2026-10-27T00:00:00+08:00"), "after a long gap");
});

test("a one-time task is due only while its time is ahead", () => {
  const once: Schedule = { kind: "once", at: "2026-10-26T12:00:00.000Z" };
  assert.deepEqual(nextOccurrence(once, at("2026-10-26T10:00:00+08:00")), at("2026-10-26T12:00:00Z"));
  assert.equal(nextOccurrence(once, at("2026-10-26T12:00:00Z")), undefined, "its time itself is not after");
  assert.equal(nextOccurrence(once, at("2026-10-26T13:00:00Z")), undefined, "later it is past");
});

test("occurrencesBetween lists the times in (from, to], oldest first, and stops at 1000", () => {
  const daily: Schedule = { kind: "daily", time: "08:00" };
  assert.deepEqual(occurrencesBetween(daily, at("2026-10-25T08:00:00+08:00"), at("2026-10-28T08:00:00+08:00")), [
    at("2026-10-26T08:00:00+08:00"),
    at("2026-10-27T08:00:00+08:00"),
    at("2026-10-28T08:00:00+08:00"),
  ]);
  const hourly: Schedule = { kind: "interval", hours: 1 };
  const many = occurrencesBetween(hourly, at("2026-10-26T00:00:00+08:00"), at("2026-12-26T00:00:00+08:00"));
  assert.equal(many.length, 1000);
  assert.deepEqual(many[0], at("2026-10-26T01:00:00+08:00"));
});
