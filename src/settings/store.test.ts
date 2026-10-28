// The settings store on files of its own and a fake environment: no model is called.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, mock, test } from "node:test";

import { SettingsSchema } from "../api/schema.ts";
import type { Settings } from "../api/schema.ts";
import type { ModelKey } from "../agent/config.ts";

// store.ts (through runs.ts) reads the state dir at import time, so set it before loading the modules under test.
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "alfred-settings-")));
process.env.ALFRED_STATE_DIR = path.join(tmp, "state");
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
afterEach(() => mock.restoreAll());

const { EventLog } = await import("../events.ts");
const { envSettings } = await import("../agent/config.ts");
const { InvalidSettings, SETTINGS_FILE, SETTINGS_MIRROR_FILE, SettingsStore } = await import("./store.ts");
const { STATE_DIR } = await import("../store.ts");

const DEFAULTS = {
  model: "sonnet",
  dailyBudgetUsd: 20,
  runBudgetUsd: 10,
  sessionIdleHours: 4,
  compactTokens: 100000,
  memoryScanMinutes: 60,
  memoryScanBudgetUsd: 0.1,
  ideasAt: "08:00",
  overridden: [],
} satisfies Settings;

let cases = 0;

/** A store on files of its own, over a fake environment and a model the test moves; `files` says where an earlier store left them. */
function setup({ env = {}, model: initial = "sonnet", dir }: { env?: Record<string, string>; model?: ModelKey; dir?: string } = {}) {
  const root = dir ?? path.join(tmp, `case-${cases++}`);
  const files = { file: path.join(root, "settings.json"), mirror: path.join(root, "workbench", "settings.json"), events: path.join(root, "events.jsonl") };
  const model = { key: initial };
  const events = new EventLog(files.events);
  const store = new SettingsStore({ file: files.file, mirror: files.mirror, events, env: () => envSettings(env), model: () => model.key });
  const announced = () => events.readSince(0).filter((e) => e.type === "settings.updated");
  const json = (file: string): unknown => JSON.parse(fs.readFileSync(file, "utf8"));
  return { store, model, files, events, announced, json, root };
}

/** What console.error was told since `mock.method` started: the warnings and errors the log prints. */
function captureWarnings(): () => string[] {
  const spy = mock.method(console, "error", () => {});
  return () => spy.mock.calls.map((call) => String(call.arguments[0]));
}

test("with nothing set anywhere the settings are the built-in defaults, and nothing is overridden", () => {
  const { store } = setup();
  assert.deepEqual(store.get(), DEFAULTS);
  assert.equal(SettingsSchema.safeParse(store.get()).success, true);
});

test("precedence: the environment over the built-in default, the owner's override over the environment, and a reset back to the environment", () => {
  const { store } = setup({ env: { ALFRED_DAILY_BUDGET_USD: "30", ALFRED_IDEAS_AT: "" } });
  assert.equal(store.get().dailyBudgetUsd, 30, "the environment beats the default");
  assert.equal(store.get().ideasAt, null, "an empty ALFRED_IDEAS_AT is off");
  assert.deepEqual(store.get().overridden, [], "the environment is not an override");

  store.update({ dailyBudgetUsd: 50, ideasAt: "09:30" });
  assert.equal(store.get().dailyBudgetUsd, 50, "the override beats the environment");
  assert.equal(store.get().ideasAt, "09:30");
  assert.deepEqual(store.get().overridden, ["dailyBudgetUsd", "ideasAt"]);

  store.update({ reset: ["dailyBudgetUsd"] });
  assert.equal(store.get().dailyBudgetUsd, 30, "a reset returns to the environment's value, not the default");
  assert.deepEqual(store.get().overridden, ["ideasAt"]);

  store.update({ reset: ["ideasAt"] });
  assert.equal(store.get().ideasAt, null);
  assert.deepEqual(store.get().overridden, []);
});

test("every setting can be overridden and reset", () => {
  const { store } = setup();
  const changes = {
    dailyBudgetUsd: 25,
    runBudgetUsd: 5,
    sessionIdleHours: 0,
    compactTokens: 0,
    memoryScanMinutes: 0,
    memoryScanBudgetUsd: 0.5,
    ideasAt: null,
  };
  const updated = store.update(changes);
  assert.deepEqual({ ...updated, overridden: undefined }, { ...DEFAULTS, ...changes, overridden: undefined });
  assert.deepEqual(updated.overridden, ["dailyBudgetUsd", "runBudgetUsd", "sessionIdleHours", "compactTokens", "memoryScanMinutes", "memoryScanBudgetUsd", "ideasAt"]);
  assert.deepEqual(store.update({ reset: ["dailyBudgetUsd", "runBudgetUsd", "sessionIdleHours", "compactTokens", "memoryScanMinutes", "memoryScanBudgetUsd", "ideasAt"] }), DEFAULTS);
});

test("the write ranges bind the owner, not the environment: a deployment's value beyond them is the effective one", () => {
  const { store, files, json } = setup({ env: { ALFRED_DAILY_BUDGET_USD: "150", ALFRED_SESSION_IDLE_HOURS: "500", ALFRED_MEMORY_SCAN_MINUTES: "5000" } });
  assert.equal(store.get().dailyBudgetUsd, 150);
  assert.equal(store.get().sessionIdleHours, 500);
  assert.equal(store.get().memoryScanMinutes, 5000);
  assert.deepEqual(json(files.mirror), store.get(), "the mirror holds the same values");
  assert.throws(() => store.update({ dailyBudgetUsd: 150 }), InvalidSettings, "the owner may not write it");
  store.update({ sessionIdleHours: 12 });
  assert.equal(store.get().sessionIdleHours, 12);
  store.update({ reset: ["sessionIdleHours"] });
  assert.equal(store.get().sessionIdleHours, 500, "a reset returns to the deployment's value");
});

test("overrides persist: a new store on the same files has them, and a reset persists too", () => {
  const first = setup({ env: { ALFRED_MAX_BUDGET_USD: "8" } });
  first.store.update({ dailyBudgetUsd: 40, ideasAt: null, runBudgetUsd: 3 });
  assert.deepEqual(first.json(first.files.file), { dailyBudgetUsd: 40, ideasAt: null, runBudgetUsd: 3 }, "the file holds the overrides only");

  const second = setup({ dir: first.root, env: { ALFRED_MAX_BUDGET_USD: "8" } });
  assert.equal(second.store.get().dailyBudgetUsd, 40);
  assert.equal(second.store.get().ideasAt, null, "an override of off survives");
  assert.equal(second.store.get().runBudgetUsd, 3);
  assert.deepEqual(second.store.get().overridden, ["dailyBudgetUsd", "runBudgetUsd", "ideasAt"]);

  second.store.update({ reset: ["dailyBudgetUsd", "ideasAt"] });
  const third = setup({ dir: first.root, env: { ALFRED_MAX_BUDGET_USD: "8" } });
  assert.equal(third.store.get().dailyBudgetUsd, 20);
  assert.equal(third.store.get().ideasAt, "08:00");
  assert.equal(third.store.get().runBudgetUsd, 3);
});

test("an invalid or unknown stored override is dropped with a warning naming the key, and the valid ones stay", () => {
  const { root, files } = setup();
  fs.writeFileSync(
    files.file,
    JSON.stringify({
      dailyBudgetUsd: 150, // above the write range
      runBudgetUsd: 7,
      sessionIdleHours: "four",
      compactTokens: 19999,
      memoryScanMinutes: -1,
      memoryScanBudgetUsd: 0,
      ideasAt: "25:00",
      model: "opus", // not kept here
      favouriteColour: "red",
    }),
  );
  const warnings = captureWarnings();
  const { store } = setup({ dir: root });
  assert.deepEqual(store.get(), { ...DEFAULTS, runBudgetUsd: 7, overridden: ["runBudgetUsd"] });
  const text = warnings().join("\n");
  for (const key of ["dailyBudgetUsd", "sessionIdleHours", "compactTokens", "memoryScanMinutes", "memoryScanBudgetUsd", "ideasAt", "model", "favouriteColour"]) {
    assert.ok(text.includes(key), `a warning names ${key}`);
  }
  assert.ok(!text.includes("runBudgetUsd"), "the valid one is not warned about");
});

test("a file that is not JSON is treated as empty with a warning, left as it is, and the next change replaces it", () => {
  const { root, files } = setup();
  fs.writeFileSync(files.file, "{ not json");
  const warnings = captureWarnings();
  const { store, announced } = setup({ dir: root });
  assert.deepEqual(store.get(), DEFAULTS);
  assert.ok(warnings().some((line) => line.includes(files.file)), "the warning names the file");
  assert.equal(fs.readFileSync(files.file, "utf8"), "{ not json", "loading does not touch it");
  store.update({ dailyBudgetUsd: 33 });
  assert.deepEqual(JSON.parse(fs.readFileSync(files.file, "utf8")), { dailyBudgetUsd: 33 });
  assert.equal(announced().length, 1);
});

test("a file that holds something else than an object is treated as empty with a warning", () => {
  for (const content of ["[1,2]", "7", "null", '"x"']) {
    const { root, files } = setup();
    fs.writeFileSync(files.file, content);
    const warnings = captureWarnings();
    const { store } = setup({ dir: root });
    assert.deepEqual(store.get(), DEFAULTS, content);
    assert.ok(warnings().some((line) => line.includes(files.file)), content);
    mock.restoreAll();
  }
});

test("a file that cannot be read does not stop the store either", () => {
  const { root, files } = setup();
  fs.mkdirSync(files.file); // reading a directory fails with EISDIR
  const warnings = captureWarnings();
  const { store } = setup({ dir: root });
  assert.deepEqual(store.get(), DEFAULTS);
  assert.ok(warnings().some((line) => line.includes(files.file)));
});

test("a malformed environment value still stops the store, naming the variable", () => {
  const bad: Record<string, string> = {
    ALFRED_DAILY_BUDGET_USD: "abc",
    ALFRED_MAX_BUDGET_USD: "-1",
    ALFRED_SESSION_IDLE_HOURS: "-2",
    ALFRED_COMPACT_TOKENS: "19999",
    ALFRED_MEMORY_SCAN_MINUTES: "x",
    ALFRED_MEMORY_SCAN_BUDGET_USD: "0",
    ALFRED_IDEAS_AT: "6pm",
  };
  for (const [name, value] of Object.entries(bad)) {
    assert.throws(() => setup({ env: { [name]: value } }), (err: Error) => err.message.includes(name) && err.message.includes(`got "${value}"`), name);
  }
});

test("the default environment layer is process.env", () => {
  process.env.ALFRED_MEMORY_SCAN_MINUTES = "17";
  try {
    const root = path.join(tmp, `case-${cases++}`);
    const store = new SettingsStore({ file: path.join(root, "settings.json"), mirror: path.join(root, "m.json"), events: new EventLog(path.join(root, "e.jsonl")) });
    assert.equal(store.get().memoryScanMinutes, 17);
    process.env.ALFRED_MEMORY_SCAN_MINUTES = "oops";
    assert.throws(() => new SettingsStore({ file: path.join(root, "settings.json"), mirror: path.join(root, "m.json"), events: new EventLog(path.join(root, "e.jsonl")) }), /ALFRED_MEMORY_SCAN_MINUTES/);
  } finally {
    delete process.env.ALFRED_MEMORY_SCAN_MINUTES;
  }
});

test("the files default to settings.json in the state dir and the same name in its workbench folder", () => {
  assert.equal(SETTINGS_FILE, path.join(STATE_DIR, "settings.json"));
  assert.equal(SETTINGS_MIRROR_FILE, path.join(STATE_DIR, "workbench", "settings.json"));
});

test("the mirror holds the effective settings from startup, with the overridden keys, and is rewritten on every change", () => {
  const { store, files, json, model } = setup({ env: { ALFRED_DAILY_BUDGET_USD: "30" } });
  assert.deepEqual(json(files.mirror), { ...DEFAULTS, dailyBudgetUsd: 30 }, "written at startup, before any change");

  store.update({ memoryScanMinutes: 0 });
  assert.deepEqual(json(files.mirror), { ...DEFAULTS, dailyBudgetUsd: 30, memoryScanMinutes: 0, overridden: ["memoryScanMinutes"] });
  model.key = "haiku";
  store.refresh();
  assert.deepEqual(json(files.mirror), store.get());
  assert.deepEqual((json(files.mirror) as Settings).overridden, ["model", "memoryScanMinutes"], "model comes first, as in the table");
  store.update({ reset: ["memoryScanMinutes"] });
  assert.deepEqual(json(files.mirror), { ...DEFAULTS, dailyBudgetUsd: 30, model: "haiku", overridden: ["model"] });
});

test("startup rewrites the mirror, so a stale one is replaced, and appends no event", () => {
  const { root, files, announced } = setup();
  fs.writeFileSync(files.mirror, JSON.stringify({ stale: true }));
  const again = setup({ dir: root, env: { ALFRED_COMPACT_TOKENS: "50000" } });
  assert.equal((again.json(files.mirror) as Settings).compactTokens, 50000);
  assert.equal(again.announced().length, 0);
  assert.equal(announced().length, 0);
});

test("a change appends one settings.updated carrying the whole settings, and a change that leaves every value as it was appends nothing and writes nothing", () => {
  const { store, announced, files } = setup({ env: { ALFRED_DAILY_BUDGET_USD: "30" } });
  assert.equal(announced().length, 0, "the startup mirror is no event");

  const settings = store.update({ dailyBudgetUsd: 45, ideasAt: null });
  assert.equal(announced().length, 1);
  assert.deepEqual(announced()[0]?.data, settings);
  assert.deepEqual(announced()[0]?.data, store.get());

  const written = fs.readFileSync(files.file, "utf8");
  const mirrored = fs.statSync(files.mirror).mtimeMs;
  const log = fs.statSync(files.events).size;
  const noOps = [
    { dailyBudgetUsd: 45 }, // already the value
    { ideasAt: null },
    { reset: ["runBudgetUsd" as const] }, // nothing to reset
    { runBudgetUsd: 10 }, // the value it already has by default
    {},
  ];
  for (const changes of noOps) assert.deepEqual(store.update(changes), settings, JSON.stringify(changes));
  assert.equal(announced().length, 1, "no event for a no-op");
  assert.equal(fs.readFileSync(files.file, "utf8"), written, "the overrides file is not written");
  assert.equal(fs.statSync(files.mirror).mtimeMs, mirrored, "nor the mirror");
  assert.equal(fs.statSync(files.events).size, log);
});

test("one update changing several settings is one event; the settings of two updates are two", () => {
  const { store, announced } = setup();
  store.update({ dailyBudgetUsd: 45, runBudgetUsd: 5, sessionIdleHours: 6 });
  assert.equal(announced().length, 1);
  store.update({ reset: ["dailyBudgetUsd", "runBudgetUsd"] });
  assert.equal(announced().length, 2);
  assert.deepEqual(announced().map((e) => (e.data as Settings).overridden), [["dailyBudgetUsd", "runBudgetUsd", "sessionIdleHours"], ["sessionIdleHours"]]);
});

test("setting a value equal to the one the environment gives drops the override, so it follows the environment and is not listed as overridden", () => {
  const { store, announced, json, files } = setup({ env: { ALFRED_DAILY_BUDGET_USD: "30" } });
  store.update({ dailyBudgetUsd: 50 });
  store.update({ dailyBudgetUsd: 30 });
  assert.deepEqual(store.get().overridden, []);
  assert.deepEqual(json(files.file), {}, "no override is kept");
  assert.equal(announced().length, 2);
  store.update({ dailyBudgetUsd: 30 });
  assert.equal(announced().length, 2);
});

test("overridden lists model when it is not sonnet, first, and a model change reaches the log through refresh", () => {
  const { store, model, announced, json, files } = setup({ model: "opus" });
  assert.deepEqual(store.get().overridden, ["model"]);
  assert.equal(store.get().model, "opus");
  assert.equal(announced().length, 0, "the model at startup is no change");
  assert.equal((json(files.mirror) as Settings).model, "opus");

  store.update({ ideasAt: "09:00" });
  assert.deepEqual(store.get().overridden, ["model", "ideasAt"]);

  model.key = "sonnet";
  assert.equal(announced().length, 1);
  store.refresh();
  assert.equal(announced().length, 2, "the model went back to sonnet");
  assert.deepEqual(store.get().overridden, ["ideasAt"]);
  assert.equal((announced()[1]?.data as Settings).model, "sonnet");

  store.refresh();
  assert.equal(announced().length, 2, "refresh with nothing changed appends nothing");
});

test("a change of the model and of a stored setting made before one update is announced once, by that update", () => {
  const { store, model, announced } = setup();
  model.key = "haiku";
  store.update({ dailyBudgetUsd: 60 });
  assert.equal(announced().length, 1);
  assert.deepEqual(announced()[0]?.data, { ...DEFAULTS, model: "haiku", dailyBudgetUsd: 60, overridden: ["model", "dailyBudgetUsd"] });
});

test("useModel gives the store the model's source after construction and rewrites the mirror without announcing", () => {
  const root = path.join(tmp, `case-${cases++}`);
  const mirror = path.join(root, "m.json");
  const events = new EventLog(path.join(root, "e.jsonl"));
  const store = new SettingsStore({ file: path.join(root, "s.json"), mirror, events, env: () => envSettings({}) });
  assert.equal(store.get().model, "sonnet", "until it has a source the model is the default");
  let key: ModelKey = "opus";
  store.useModel(() => key);
  assert.equal(store.get().model, "opus");
  assert.equal((JSON.parse(fs.readFileSync(mirror, "utf8")) as Settings).model, "opus");
  assert.equal(events.readSince(0).length, 0);
  key = "haiku";
  store.refresh();
  assert.equal(events.readSince(0).length, 1);
});

test("listeners hear a change with the settings before it, not a no-op, and a listener that throws does not fail the update", () => {
  const { store, model } = setup();
  const heard: [Settings, Settings][] = [];
  const off = store.onChange((now, before) => heard.push([now, before]));
  store.onChange(() => {
    throw new Error("listener broke");
  });
  const warnings = captureWarnings();

  const settings = store.update({ memoryScanMinutes: 5 });
  assert.equal(heard.length, 1);
  assert.deepEqual(heard[0]?.[0], settings);
  assert.equal(heard[0]?.[1].memoryScanMinutes, 60);
  assert.ok(warnings().some((line) => line.includes("listener broke")));

  store.update({ memoryScanMinutes: 5 });
  assert.equal(heard.length, 1, "no change, no call");
  model.key = "opus";
  store.refresh();
  assert.equal(heard.length, 2, "a model change is heard too");
  off();
  store.update({ memoryScanMinutes: 6 });
  assert.equal(heard.length, 2, "a listener stops with its function");
});

test("an update outside the write ranges, naming the model, or setting and resetting a key is refused and changes nothing", () => {
  const { store, announced, files } = setup();
  const refused: [object, RegExp][] = [
    [{ dailyBudgetUsd: 0 }, /dailyBudgetUsd/],
    [{ dailyBudgetUsd: 101 }, /dailyBudgetUsd/],
    [{ runBudgetUsd: 21 }, /runBudgetUsd/],
    [{ sessionIdleHours: 169 }, /sessionIdleHours/],
    [{ compactTokens: 19999 }, /compactTokens/],
    [{ compactTokens: 1_000_001 }, /compactTokens/],
    [{ memoryScanMinutes: 1441 }, /memoryScanMinutes/],
    [{ memoryScanBudgetUsd: 0 }, /memoryScanBudgetUsd/],
    [{ memoryScanBudgetUsd: 2 }, /memoryScanBudgetUsd/],
    [{ ideasAt: "24:00" }, /ideasAt/],
    [{ model: "opus" }, /model/],
    [{ reset: ["model"] }, /model/],
    [{ favouriteColour: "red" }, /favouriteColour/],
    [{ dailyBudgetUsd: 5, reset: ["dailyBudgetUsd"] }, /dailyBudgetUsd/],
    [{ dailyBudgetUsd: 5, runBudgetUsd: 99 }, /runBudgetUsd/],
  ];
  for (const [changes, message] of refused) {
    assert.throws(() => store.update(changes as never), (err: Error) => err instanceof InvalidSettings && message.test(err.message), JSON.stringify(changes));
  }
  assert.deepEqual(store.get(), DEFAULTS);
  assert.equal(announced().length, 0);
  assert.equal(fs.existsSync(files.file), false);
});

test("an update that cannot be saved is an error, and leaves the settings, the mirror and the log as they were", () => {
  const { store, root, files, announced } = setup();
  fs.writeFileSync(path.join(root, "blocker"), "a file where a directory is needed");
  captureWarnings(); // the store warns that it cannot read its file, which is no directory
  const blocked = new SettingsStore({
    file: path.join(root, "blocker", "settings.json"),
    mirror: files.mirror,
    events: new EventLog(files.events),
    env: () => envSettings({}),
  });
  assert.throws(() => blocked.update({ dailyBudgetUsd: 33 }));
  assert.deepEqual(blocked.get(), DEFAULTS);
  assert.equal(announced().length, 0);
  assert.deepEqual(store.get(), DEFAULTS);
});
