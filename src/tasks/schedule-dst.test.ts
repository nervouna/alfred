import assert from "node:assert/strict";
import { test } from "node:test";

import type { Schedule } from "../api/schema.ts";

// New York moves its clocks forward on 2026-03-08 (02:00 to 03:00) and back on 2026-11-01 (02:00 to 01:00).
process.env.TZ = "America/New_York";

const { nextOccurrence, occurrencesBetween } = await import("./schedule.ts");

const at = (iso: string) => new Date(iso);

test("a daily time in the spring-forward gap runs once, at the time Date gives it", () => {
  const daily: Schedule = { kind: "daily", time: "02:30" };
  assert.deepEqual(occurrencesBetween(daily, at("2026-03-07T12:00:00-05:00"), at("2026-03-09T12:00:00-04:00")), [
    at("2026-03-08T03:30:00-04:00"), // 02:30 does not exist on 8 March; Date gives 03:30 EDT
    at("2026-03-09T02:30:00-04:00"),
  ]);
});

test("a daily time in the fall-back hour runs once, at its first instance", () => {
  const daily: Schedule = { kind: "daily", time: "01:30" };
  assert.deepEqual(occurrencesBetween(daily, at("2026-10-31T12:00:00-04:00"), at("2026-11-02T12:00:00-05:00")), [
    at("2026-11-01T01:30:00-04:00"),
    at("2026-11-02T01:30:00-05:00"),
  ]);
});

test("a daily time keeps its local hour across both changes", () => {
  const daily: Schedule = { kind: "daily", time: "08:00" };
  const times = occurrencesBetween(daily, at("2026-03-01T00:00:00-05:00"), at("2026-11-30T00:00:00-05:00"));
  assert.ok(times.length > 200);
  assert.ok(times.every((t) => t.getHours() === 8 && t.getMinutes() === 0), "every run is at 08:00 local");
  // Local 08:00 on consecutive days is 23 hours apart across the spring change (8 March) and 25 across the autumn one (1 November).
  const hoursBetween = (day: string, next: string) => (new Date(`${next}T08:00:00`).getTime() - new Date(`${day}T08:00:00`).getTime()) / 3_600_000;
  assert.equal(hoursBetween("2026-03-07", "2026-03-08"), 23);
  assert.equal(hoursBetween("2026-03-01", "2026-03-02"), 24);
  assert.equal(hoursBetween("2026-10-31", "2026-11-01"), 25);
});

test("an interval keeps its elapsed hours across a change", () => {
  const everyDay: Schedule = { kind: "interval", hours: 24 };
  assert.deepEqual(nextOccurrence(everyDay, at("2026-03-07T12:00:00-05:00")), at("2026-03-08T13:00:00-04:00"), "24 hours later is 13:00 EDT the next day");
  assert.deepEqual(nextOccurrence(everyDay, at("2026-03-08T12:00:00-04:00"), at("2026-03-07T12:00:00-05:00")), at("2026-03-08T13:00:00-04:00"));
});
