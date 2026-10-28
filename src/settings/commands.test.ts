// The settings command on a real store and a stand-in for the handler's model switch.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, mock, test } from "node:test";

import type { Settings, SettingsUpdate } from "../api/schema.ts";
import { SettingsResultSchema, parseCommand } from "../api/schema.ts";
import type { ModelKey } from "../agent/config.ts";

// store.ts reads the state dir at import time (through runs.ts), so set it before loading the modules under test.
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "alfred-settings-commands-")));
process.env.ALFRED_STATE_DIR = path.join(tmp, "state");
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
afterEach(() => mock.restoreAll());

const { EventLog } = await import("../events.ts");
const { envSettings } = await import("../agent/config.ts");
const { SettingsStore } = await import("./store.ts");
const { settingsCommands } = await import("./commands.ts");

let cases = 0;

/** A store and commands over it; `setModel` stands in for the handler's, and moves the model the store reads. */
function setup(initial: ModelKey = "sonnet") {
  const dir = path.join(tmp, `case-${cases++}`);
  const model = { key: initial, switched: [] as ModelKey[], fail: false };
  const events = new EventLog(path.join(dir, "events.jsonl"));
  const store = new SettingsStore({
    file: path.join(dir, "settings.json"),
    mirror: path.join(dir, "mirror.json"),
    events,
    env: () => envSettings({}),
    model: () => model.key,
  });
  const handler = {
    async setModel(key: ModelKey) {
      model.switched.push(key);
      model.key = key;
      if (model.fail) throw new Error("the query is gone");
      return false;
    },
  };
  const commands = settingsCommands(store, handler);
  const announced = () => events.readSince(0).filter((e) => e.type === "settings.updated");
  /** The command as the API hands it over: parsed, so the types and ranges are the contract's. */
  const update = async (json: object) => {
    const parsed = parseCommand({ type: "settings.update", ...json });
    if (!parsed.ok || parsed.command.type !== "settings.update") throw new Error(parsed.ok ? "not a settings command" : parsed.error);
    return commands.update(parsed.command satisfies SettingsUpdate);
  };
  return { store, model, commands, announced, update };
}

test("the answer is a SettingsResult body: the settings after the change", async () => {
  const { update, store } = setup();
  const reply = await update({ dailyBudgetUsd: 30 });
  assert.equal(reply.ok, true);
  if (!reply.ok) return;
  assert.deepEqual(reply.settings, store.get());
  assert.equal(reply.settings.dailyBudgetUsd, 30);
  assert.equal(SettingsResultSchema.safeParse({ settings: reply.settings }).success, true);
});

test("a command that sets a model and other settings switches the model once and announces one change", async () => {
  const { update, model, announced, store } = setup();
  const reply = await update({ model: "opus", dailyBudgetUsd: 30, reset: ["runBudgetUsd"] });
  assert.deepEqual(model.switched, ["opus"]);
  assert.equal(announced().length, 1, "one event for the command, with all of it");
  assert.deepEqual(announced()[0]?.data, store.get());
  assert.deepEqual((announced()[0]?.data as Settings).overridden, ["model", "dailyBudgetUsd"]);
  assert.equal(reply.ok && reply.settings.model, "opus");
});

test("a command that only changes the model announces it through the store", async () => {
  const { update, announced } = setup();
  await update({ model: "haiku" });
  assert.equal(announced().length, 1);
  assert.equal((announced()[0]?.data as Settings).model, "haiku");
});

test("resetting the model means sonnet", async () => {
  const { update, model, announced, store } = setup("opus");
  const reply = await update({ reset: ["model"] });
  assert.deepEqual(model.switched, ["sonnet"]);
  assert.equal(store.get().model, "sonnet");
  assert.deepEqual(store.get().overridden, []);
  assert.equal(announced().length, 1);
  assert.equal(reply.ok && reply.settings.model, "sonnet");
});

test("a model the chat is on already is not switched again, and announces nothing", async () => {
  const { update, model, announced } = setup("opus");
  await update({ model: "opus" });
  assert.deepEqual(model.switched, []);
  assert.equal(announced().length, 0);
  const again = setup();
  await again.update({ reset: ["model"] });
  assert.deepEqual(again.model.switched, []);
  assert.equal(again.announced().length, 0);
});

test("settings other than the model never touch the model switch", async () => {
  const { update, model } = setup();
  await update({ ideasAt: null, sessionIdleHours: 0, compactTokens: 0 });
  await update({ reset: ["ideasAt", "sessionIdleHours"] });
  assert.deepEqual(model.switched, []);
});

test("a reset of several settings with the model among them resets all", async () => {
  const { update, store } = setup("haiku");
  await update({ dailyBudgetUsd: 70 });
  const reply = await update({ reset: ["model", "dailyBudgetUsd"] });
  assert.deepEqual(store.get().overridden, []);
  assert.equal(store.get().dailyBudgetUsd, 20);
  assert.equal(reply.ok && reply.settings.model, "sonnet");
});

test("a command that changes nothing answers with the settings and announces nothing", async () => {
  const { update, announced, store } = setup();
  const reply = await update({ dailyBudgetUsd: 20, reset: ["ideasAt"] });
  assert.equal(announced().length, 0);
  assert.deepEqual(reply.ok && reply.settings, store.get());
});

test("a model switch that fails still announces the model the chat is now on, and the error goes up", async () => {
  const { update, model, announced } = setup();
  model.fail = true;
  mock.method(console, "error", () => {});
  await assert.rejects(update({ model: "opus", dailyBudgetUsd: 30 }), /the query is gone/);
  assert.equal(announced().length, 1, "the key is stored, so the change of model is announced");
  assert.equal((announced()[0]?.data as Settings).model, "opus");
  assert.equal((announced()[0]?.data as Settings).dailyBudgetUsd, 20, "the rest was not applied");
});
