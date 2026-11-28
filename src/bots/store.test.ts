import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";

// store.ts reads this at import time (through runs.ts), so set it before loading the module under test.
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "alfred-bots-")));
process.env.ALFRED_STATE_DIR = path.join(tmp, "state");
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { BotListSchema, EventSchema } = await import("../api/schema.ts");
const { EventLog } = await import("../events.ts");
const { BotStore, InvalidBot } = await import("./store.ts");

const START = new Date("2026-11-28T02:00:00Z");
/** The clock the stores read; a test moves it forward where it needs a later time. */
let clock = START;
const now = () => clock;
beforeEach(() => {
  clock = START;
});

let opened = 0;
/** A store on files of its own, reading the clock. */
function open() {
  const dir = path.join(tmp, `store-${opened++}`);
  const file = path.join(dir, "bots.json");
  const events = new EventLog(path.join(dir, "events.jsonl"));
  return { file, events, store: new BotStore({ file, events, now }) };
}

const input = {
  id: "x",
  name: "X",
  description: "读 X 上的动态，每天整理成一份简报。",
  instructions: "你是 X，负责跟进 X 上的关注列表。只读不发，整理时按主题归类，附上原帖链接。",
  model: "haiku" as const,
  runBudgetUsd: 1,
  tools: ["WebFetch", "WebSearch"],
};

/** The bot.updated events of a log, oldest first. */
function botEvents(events: InstanceType<typeof EventLog>) {
  return events.readSince(0).flatMap((event) => (event.type === "bot.updated" ? [event] : []));
}

test("create stamps the bot, lists it and gets it; the alfred id is never a bot", () => {
  const { file, events, store } = open();
  const bot = store.create(input);

  assert.deepEqual(bot, { ...input, createdAt: START.toISOString(), updatedAt: START.toISOString() });
  assert.deepEqual(store.list(), [bot]);
  assert.deepEqual(store.get("x"), bot);
  assert.equal(store.get("alfred"), undefined);
  assert.deepEqual(BotListSchema.parse(JSON.parse(fs.readFileSync(file, "utf8"))), { bots: [bot] });
  const logged = botEvents(events);
  assert.equal(logged.length, 1);
  assert.deepEqual(logged[0]?.data, bot);
});

test("a second store on the same file reads the bots back, oldest created first", () => {
  const { file, events, store } = open();
  store.create(input);
  clock = new Date("2026-11-28T03:00:00Z");
  store.create({ ...input, id: "y", name: "Y" });

  const reopened = new BotStore({ file, events, now });
  assert.deepEqual(
    reopened.list().map((bot) => bot.id),
    ["x", "y"],
  );
});

test("list returns a copy, so changing it does not change the store", () => {
  const { store } = open();
  store.create(input);
  store.list().pop();
  assert.equal(store.list().length, 1);
});

test("create refuses a taken id, the alfred id and any input the schema rejects, and writes nothing", () => {
  const { file, events, store } = open();
  store.create(input);
  const before = fs.readFileSync(file, "utf8");
  const refused: [string, Partial<typeof input>][] = [
    ["a taken id", { id: "x" }],
    ["the alfred id", { id: "alfred" }],
    ["an id with capitals", { id: "Bad" }],
    ["an id ending with -", { id: "bad-" }],
    ["a blank name", { id: "z", name: "   " }],
    ["a budget of 0", { id: "z", runBudgetUsd: 0 }],
    ["a budget above the chat cap", { id: "z", runBudgetUsd: 1000 }],
    ["an unknown model", { id: "z", model: "gpt" as never }],
    ["a repeated tool", { id: "z", tools: ["WebFetch", "WebFetch"] }],
    ["empty instructions", { id: "z", instructions: "" }],
  ];
  for (const [what, patch] of refused) {
    assert.throws(() => store.create({ ...input, ...patch }), InvalidBot, what);
  }
  assert.equal(store.list().length, 1);
  assert.equal(fs.readFileSync(file, "utf8"), before);
  assert.equal(botEvents(events).length, 1);
});

test("update changes the given fields, keeps the rest and the creation time, and appends one bot.updated per change", () => {
  const { events, store } = open();
  store.create(input);
  clock = new Date("2026-11-28T04:00:00Z");

  const renamed = store.update("x", { name: "Ex" });
  assert.equal(renamed.name, "Ex");
  assert.equal(renamed.createdAt, START.toISOString());
  assert.equal(renamed.updatedAt, "2026-11-28T04:00:00.000Z");
  assert.deepEqual(renamed.tools, input.tools);

  clock = new Date("2026-11-28T05:00:00Z");
  const retooled = store.update("x", { model: "sonnet", tools: ["WebSearch"], runBudgetUsd: 2 });
  assert.deepEqual(store.get("x"), retooled);
  assert.equal(retooled.updatedAt, "2026-11-28T05:00:00.000Z");

  const logged = botEvents(events);
  assert.equal(logged.length, 3, "create, then one event per changing update");
  for (const event of logged) assert.equal(EventSchema.safeParse(event).success, true);
  assert.deepEqual(logged[2]?.data, retooled);
});

test("update refuses an unknown id and any result the schema rejects, and writes nothing", () => {
  const { file, events, store } = open();
  store.create(input);
  const before = fs.readFileSync(file, "utf8");
  assert.throws(() => store.update("nope", { name: "N" }), InvalidBot, "an unknown id");
  assert.throws(() => store.update("x", { name: "  " }), InvalidBot, "a blank name");
  assert.throws(() => store.update("x", { runBudgetUsd: 1000 }), InvalidBot, "a budget above the chat cap");
  assert.throws(() => store.update("x", { tools: ["WebFetch", "WebFetch"] }), InvalidBot, "a repeated tool");
  assert.equal(store.get("x")?.name, "X");
  assert.equal(fs.readFileSync(file, "utf8"), before);
  assert.equal(botEvents(events).length, 1);
});

test("an update that sets every field to its current value writes nothing and appends nothing", () => {
  const { file, events, store } = open();
  const bot = store.create(input);
  const before = fs.readFileSync(file, "utf8");
  clock = new Date("2026-11-28T06:00:00Z");

  assert.deepEqual(store.update("x", { name: "X", tools: ["WebFetch", "WebSearch"], runBudgetUsd: 1 }), bot);
  assert.deepEqual(store.update("x", {}), bot);
  assert.equal(fs.readFileSync(file, "utf8"), before);
  assert.equal(botEvents(events).length, 1);
});

test("a missing file is no bots; a file that is not valid JSON or not a bot list throws at construction, naming the file", () => {
  const { file, events } = open();
  assert.deepEqual(new BotStore({ file, events, now }).list(), []);

  for (const body of ["{ not json", JSON.stringify({ bots: [{ id: "alfred" }] })]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
    assert.throws(
      () => new BotStore({ file, events, now }),
      (err: unknown) => err instanceof Error && err.message.includes(file),
      body,
    );
  }
});
