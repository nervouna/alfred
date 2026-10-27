// The daily generation of ideas, on a fake clock, a fake timer and a state file of its own: no model is called.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, mock, test } from "node:test";

import type { IdeaGenerationAccepted, IdeaTrigger } from "../api/schema.ts";
import type { IdeaReply } from "../api/server.ts";
import type { IdeaDraft } from "./store.ts";

// Times are local: pin the zone before any date is made, so the result does not depend on the machine.
process.env.TZ = "Asia/Taipei";
// store.ts reads this at import time (through runs.ts), so set it before loading the modules under test.
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "alfred-ideas-schedule-")));
process.env.ALFRED_STATE_DIR = path.join(tmp, "state");
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
afterEach(() => {
  mock.timers.reset();
  mock.restoreAll();
});

const { EventLog } = await import("../events.ts");
const { IdeaStore } = await import("./store.ts");
const { IDEAS_SCHEDULE_FILE, OPEN_IDEAS_SKIP, startDailyIdeas } = await import("./schedule.ts");
const { parseIdeasAt } = await import("../agent/config.ts");
const { STATE_DIR } = await import("../store.ts");

/** 2026-10-27, Tuesday, at a local (Taipei) time. */
const at = (time: string, day = "2026-10-27") => new Date(`${day}T${time}:00+08:00`);
const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

const draft: IdeaDraft = {
  title: "对比三家 VPS 的带宽配额",
  why: "上一份价格报告没有写带宽，你在对话里问过这件事。",
  brief: "查三家供应商官网的带宽政策，整理成一张表。",
  kind: "once",
  model: "sonnet",
  estimateUsd: 0.35,
};

let opened = 0;
/**
 * A schedule on a fake timer and a clock the test moves, with an idea store of `open` open ideas and a `generate` that
 * answers what the test says (a run id by default). `tick` moves the clock by `ms` and the timer with it.
 */
function setup({ time = "08:00", start = at("07:00"), open = 0, file, replies }: { time?: string | null; start?: Date; open?: number; file?: string; replies?: IdeaReply<IdeaGenerationAccepted>[] } = {}) {
  // A test may set up several schedules; each starts on a fresh fake timer.
  mock.timers.reset();
  mock.timers.enable({ apis: ["setInterval"] });
  const dir = path.join(tmp, `case-${opened++}`);
  const stateFile = file ?? path.join(dir, "ideas-schedule.json");
  const clock = { now: start };
  const ideas = new IdeaStore({ file: path.join(dir, "ideas.json"), events: new EventLog(path.join(dir, "events.jsonl")), now: () => clock.now });
  if (open > 0) ideas.add(Array.from({ length: open }, (_, i) => ({ ...draft, title: `想法 ${i}` })), "k7m2qa");
  const calls: number[] = [];
  /** What each call to `generate` was told started the generation. */
  const triggers: IdeaTrigger[] = [];
  const queued = [...(replies ?? [])];
  const generate = (trigger: IdeaTrigger): IdeaReply<IdeaGenerationAccepted> => {
    calls.push(clock.now.getTime());
    triggers.push(trigger);
    return queued.shift() ?? { ok: true, body: { runId: "k7m2qa" } };
  };
  const stop = startDailyIdeas({ at: time ?? undefined, ideas, generate, file: stateFile, now: () => clock.now });
  const tick = (ms: number) => {
    clock.now = new Date(clock.now.getTime() + ms);
    mock.timers.tick(ms);
  };
  /** Moves the clock to `to` and lets the timer fire once, as a check a minute after the last would. */
  const jump = (to: Date) => {
    clock.now = to;
    mock.timers.tick(MINUTE_MS);
  };
  const savedDay = (): string | undefined => {
    try {
      return (JSON.parse(fs.readFileSync(stateFile, "utf8")) as { lastDay?: string }).lastDay;
    } catch {
      return undefined;
    }
  };
  return { clock, ideas, calls, triggers, generate, stop, tick, jump, stateFile, savedDay };
}

/** The lines the log wrote while `fn` ran. */
function logged(): { lines: () => string[] } {
  const info = mock.method(console, "log", () => {});
  const warn = mock.method(console, "error", () => {});
  return { lines: () => [...info.mock.calls, ...warn.mock.calls].map((call) => String(call.arguments[0])) };
}

test("it checks at startup and then every minute: not before the time, and when the local time reaches it", () => {
  const s = setup({ start: at("07:58") });
  assert.deepEqual(s.calls, [], "not before the time");

  s.tick(MINUTE_MS); // 07:59
  assert.deepEqual(s.calls, []);
  s.tick(MINUTE_MS - 1); // 07:59:59.999
  assert.deepEqual(s.calls, []);
  s.tick(1); // 08:00:00 on the check
  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0], at("08:00").getTime());
  s.stop();
});

test("the generation it starts is a daily one, on every day and on a retry after a refusal", () => {
  const s = setup({ start: at("07:59"), replies: [{ ok: false, status: 409, error: "ideas are being generated" }] });
  s.tick(MINUTE_MS); // refused
  s.tick(MINUTE_MS); // started
  s.jump(at("08:00", "2026-10-28"));
  assert.equal(s.calls.length, 3);
  assert.deepEqual(s.triggers, ["daily", "daily", "daily"]);
  s.stop();
});

test("a start after the time checks at once and does not wait a minute", () => {
  const s = setup({ start: at("08:00") });
  assert.equal(s.calls.length, 1, "due when it starts");
  s.stop();
});

test("the day is done once its generation has started: it runs once a day, and again the next day", () => {
  const s = setup({ start: at("07:59") });
  s.tick(MINUTE_MS);
  assert.equal(s.calls.length, 1);
  assert.equal(s.savedDay(), "2026-10-27");
  assert.deepEqual(JSON.parse(fs.readFileSync(s.stateFile, "utf8")), { lastDay: "2026-10-27" });

  for (let t = at("08:01"); t < at("23:59"); t = new Date(t.getTime() + 37 * MINUTE_MS)) s.jump(t);
  assert.equal(s.calls.length, 1, "the rest of the day");

  s.jump(at("07:59", "2026-10-28"));
  assert.equal(s.calls.length, 1, "not before the time the next day");
  s.jump(at("08:00", "2026-10-28"));
  assert.equal(s.calls.length, 2);
  assert.equal(s.savedDay(), "2026-10-28");
  s.stop();
});

test("a generation at most 6 hours late runs once; later it is skipped, logged, and the day is done", () => {
  const edge = setup({ start: at("14:00") }); // exactly 6 hours late
  assert.equal(edge.calls.length, 1, "6 hours late is still on time");
  edge.stop();

  const late = setup({ start: at("13:59") });
  assert.equal(late.calls.length, 1, "5 hours 59 minutes late");
  late.stop();

  const lines = logged();
  const missed = setup({ start: at("14:01") }); // 6 hours 1 minute late
  assert.deepEqual(missed.calls, []);
  assert.equal(missed.savedDay(), "2026-10-27", "the skip is recorded as the day's");
  assert.ok(lines.lines().some((line) => /daily ideas.*2026-10-27.*skipped.*late/i.test(line)), "and logged");
  missed.jump(at("15:00"));
  missed.jump(at("20:00"));
  assert.deepEqual(missed.calls, [], "it does not run later that day");
  missed.jump(at("08:00", "2026-10-28"));
  assert.equal(missed.calls.length, 1, "and the next day is its own");
  missed.stop();
  assert.equal(HOUR_MS * 6, 21_600_000);
});

test("with 5 or more open ideas the day is skipped, logged and done; with fewer it runs", () => {
  assert.equal(OPEN_IDEAS_SKIP, 5);
  const four = setup({ start: at("08:00"), open: 4 });
  assert.equal(four.calls.length, 1, "4 open ideas do not skip it");
  four.stop();

  const lines = logged();
  const five = setup({ start: at("08:00"), open: 5 });
  assert.deepEqual(five.calls, []);
  assert.equal(five.savedDay(), "2026-10-27", "the skip is the day's");
  assert.ok(lines.lines().some((line) => /daily ideas.*skipped.*5 open/i.test(line)));
  // Answering the ideas later that day does not bring the generation back.
  for (const idea of five.ideas.list()) five.ideas.reject(idea.id, { reason: "not-now" });
  five.jump(at("09:00"));
  assert.deepEqual(five.calls, [], "nor does answering them");
  five.stop();

  // Only open ideas count: 6 ideas, 2 of them answered before the time, leave 4.
  const closed = setup({ start: at("07:59"), open: 6 });
  for (const idea of closed.ideas.list().slice(0, 2)) closed.ideas.reject(idea.id, { reason: "not-now" });
  closed.tick(MINUTE_MS);
  assert.equal(closed.calls.length, 1, "4 open ideas do not skip it");
  closed.stop();
});

test("a refusal (the cap, a generation running, closing) is logged once and tried again on the next check, and the day is not done", () => {
  const lines = logged();
  const refused: IdeaReply<IdeaGenerationAccepted> = { ok: false, status: 409, error: "today's spend cap is reached" };
  const s = setup({ start: at("08:00"), replies: [refused, refused, { ok: false, status: 409, error: "ideas are being generated" }] });
  assert.equal(s.calls.length, 1);
  assert.equal(s.savedDay(), undefined, "not done");

  s.tick(MINUTE_MS);
  s.tick(MINUTE_MS);
  assert.equal(s.calls.length, 3, "tried again on each check");
  s.tick(MINUTE_MS);
  assert.equal(s.calls.length, 4, "and it started on the fourth");
  assert.equal(s.savedDay(), "2026-10-27", "now the day is done");
  s.tick(MINUTE_MS);
  assert.equal(s.calls.length, 4);

  const said = lines.lines().filter((line) => /daily ideas/.test(line));
  assert.equal(said.filter((line) => /spend cap is reached/.test(line)).length, 1, "the same refusal is logged once, not every minute");
  assert.equal(said.filter((line) => /ideas are being generated/.test(line)).length, 1, "a different one is logged");
  s.stop();
});

test("a refusal that goes on is skipped for lateness at last: 6 hours later the day is done without a run", () => {
  const refused: IdeaReply<IdeaGenerationAccepted> = { ok: false, status: 409, error: "Alfred is shutting down" };
  const s = setup({ start: at("08:00"), replies: Array.from({ length: 1000 }, () => refused) });
  s.jump(at("13:59"));
  assert.equal(s.savedDay(), undefined);
  s.jump(at("14:01"));
  assert.equal(s.savedDay(), "2026-10-27", "late, so the day is done");
  const before = s.calls.length;
  s.jump(at("15:00"));
  assert.equal(s.calls.length, before);
  s.stop();
});

test("a restart on a day that is done does not run again", () => {
  const first = setup({ start: at("08:00") });
  assert.equal(first.calls.length, 1);
  first.stop();

  const second = setup({ start: at("08:30"), file: first.stateFile });
  assert.deepEqual(second.calls, [], "the restart finds the day done");
  second.jump(at("12:00"));
  assert.deepEqual(second.calls, []);
  second.stop();

  const next = setup({ start: at("08:05", "2026-10-28"), file: first.stateFile });
  assert.equal(next.calls.length, 1, "the next day runs");
  next.stop();
});

test("a state file that cannot be read counts as no record, and the schedule goes on", () => {
  const dir = path.join(tmp, "broken");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "ideas-schedule.json");
  fs.writeFileSync(file, "{ not json");
  const lines = logged();
  const s = setup({ start: at("08:00"), file });
  assert.equal(s.calls.length, 1);
  assert.ok(lines.lines().some((line) => /ideas-schedule\.json/.test(line)));
  assert.equal(s.savedDay(), "2026-10-27", "and it is written over");
  s.stop();
});

test("a failing write of the state does not make the day run again", () => {
  const dir = path.join(tmp, "unwritable");
  fs.mkdirSync(dir, { recursive: true });
  // A directory where the file should be makes every write fail.
  const file = path.join(dir, "ideas-schedule.json");
  fs.mkdirSync(file);
  const lines = logged();
  const s = setup({ start: at("08:00"), file });
  assert.equal(s.calls.length, 1);
  s.tick(MINUTE_MS);
  s.tick(MINUTE_MS);
  assert.equal(s.calls.length, 1, "the day is remembered in memory");
  assert.ok(lines.lines().some((line) => /ideas-schedule\.json|saving/i.test(line)));
  s.stop();
});

test("a generate that throws is logged and the timer goes on", () => {
  const lines = logged();
  mock.timers.enable({ apis: ["setInterval"] });
  const clock = { now: at("08:00") };
  const dir = path.join(tmp, "throws");
  const ideas = new IdeaStore({ file: path.join(dir, "ideas.json"), events: new EventLog(path.join(dir, "events.jsonl")) });
  let calls = 0;
  const stop = startDailyIdeas({
    at: "08:00",
    ideas,
    generate: () => {
      if (++calls === 1) throw new Error("disk full");
      return { ok: true, body: { runId: "k7m2qa" } };
    },
    file: path.join(dir, "ideas-schedule.json"),
    now: () => clock.now,
  });
  assert.equal(calls, 1);
  assert.ok(lines.lines().some((line) => /disk full/.test(line)));
  mock.timers.tick(MINUTE_MS);
  assert.equal(calls, 2, "the next check ran");
  stop();
});

test("stopping ends the checks", () => {
  const s = setup({ start: at("07:00") });
  s.stop();
  s.clock.now = at("08:30");
  mock.timers.tick(10 * MINUTE_MS);
  assert.deepEqual(s.calls, []);
});

test("the timer does not keep the process alive", () => {
  const created: { hasRef(): boolean }[] = [];
  const realSetInterval = globalThis.setInterval;
  mock.method(globalThis, "setInterval", ((...args: Parameters<typeof setInterval>) => {
    const timer = realSetInterval(...args);
    created.push(timer);
    return timer;
  }) as typeof setInterval);
  const dir = path.join(tmp, "unref");
  const stop = startDailyIdeas({
    at: "08:00",
    ideas: new IdeaStore({ file: path.join(dir, "ideas.json"), events: new EventLog(path.join(dir, "events.jsonl")) }),
    generate: () => ({ ok: false, status: 409, error: "no" }),
    file: path.join(dir, "ideas-schedule.json"),
    now: () => at("07:00"),
  });
  assert.equal(created.length, 1);
  assert.equal(created[0]?.hasRef(), false);
  stop();
});

test("with no time the daily generation is off: nothing is checked and nothing runs", () => {
  const s = setup({ time: null, start: at("08:00") });
  s.jump(at("08:30"));
  s.jump(at("12:00"));
  assert.deepEqual(s.calls, []);
  assert.equal(s.savedDay(), undefined);
  s.stop();
});

test("the setting: HH:MM, empty turns it off, anything else fails with a message", () => {
  assert.equal(parseIdeasAt("08:00"), "08:00");
  assert.equal(parseIdeasAt("23:59"), "23:59");
  assert.equal(parseIdeasAt(" 09:30 "), "09:30");
  assert.equal(parseIdeasAt(""), undefined);
  assert.equal(parseIdeasAt("   "), undefined);
  for (const bad of ["8:00", "24:00", "08:60", "08.00", "0800", "noon", "08:00:00", "8", "-1"]) {
    assert.throws(() => parseIdeasAt(bad), new RegExp(`ALFRED_IDEAS_AT must be a 24-hour time as HH:MM.*got "${bad.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`), bad);
  }
  assert.throws(() => startDailyIdeas({ at: "noon", ideas: new IdeaStore({ file: path.join(tmp, "x", "ideas.json"), events: new EventLog(path.join(tmp, "x", "e.jsonl")) }), generate: () => ({ ok: false, status: 409, error: "no" }) }), /HH:MM/);
});

test("ALFRED_IDEAS_AT is read where the other settings are: unset is 08:00, empty is off, an invalid one fails", () => {
  const read = (env: Record<string, string>): string => {
    const code = `import { ideasAt } from "./src/agent/config.ts"; try { console.log(JSON.stringify({ at: ideasAt() ?? null })); } catch (err) { console.log(JSON.stringify({ error: err.message })); }`;
    const base: Record<string, string | undefined> = { ...process.env, ALFRED_STATE_DIR: path.join(tmp, "setting") };
    delete base.ALFRED_IDEAS_AT;
    return execFileSync(process.execPath, ["--input-type=module", "-e", code], { env: { ...base, ...env }, cwd: path.join(import.meta.dirname, "..", ".."), encoding: "utf8" }).trim();
  };
  assert.equal(read({}), '{"at":"08:00"}');
  assert.equal(read({ ALFRED_IDEAS_AT: "" }), '{"at":null}');
  assert.equal(read({ ALFRED_IDEAS_AT: "06:45" }), '{"at":"06:45"}');
  assert.match(read({ ALFRED_IDEAS_AT: "6pm" }), /ALFRED_IDEAS_AT must be a 24-hour time as HH:MM/);
});

test("the default state file is ideas-schedule.json in the state directory", () => {
  assert.equal(IDEAS_SCHEDULE_FILE, path.join(STATE_DIR, "ideas-schedule.json"));
});
