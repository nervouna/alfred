import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, mock, test } from "node:test";

import type { Event, Message, PushRegistration } from "../api/schema.ts";
import type { ApnsResult } from "./apns.ts";
import type { DeviceStore as Store } from "./devices.ts";

// store.ts and devices.ts read the state dir at import time, so set it before loading them.
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "alfred-push-")));
process.env.ALFRED_STATE_DIR = path.join(tmp, "state");
delete process.env.ALFRED_WORKBENCH_STATE;
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { DeviceStore } = await import("./devices.ts");
const { nextDelay, notificationFor, notify, pushToDevices, runPushDispatcher, startPush } = await import("./push.ts");

const AT = "2026-10-26T01:00:00.000Z";
const TOKEN_A = crypto.randomBytes(32).toString("hex");
const TOKEN_B = crypto.randomBytes(32).toString("hex");
const TOKEN_C = crypto.randomBytes(32).toString("hex");
const TOKEN_D = crypto.randomBytes(32).toString("hex");

let stores = 0;
function freshDevices(): Store {
  return new DeviceStore(path.join(tmp, `app-${stores++}`));
}

/** A message.created event; the defaults are an outbound app reply. */
function messageEvent(id: number, message: Partial<Message> = {}): Event {
  return {
    id,
    at: AT,
    type: "message.created",
    data: { id: `m-${id}`, channel: "app", direction: "out", text: "好", files: [], at: AT, ...message },
  };
}

function runEvent(id: number): Event {
  return {
    id,
    at: AT,
    type: "run.updated",
    data: { id: "abcdef", kind: "task", title: "t", status: "done", startedAt: AT, costUsd: 0, files: [] },
  };
}

/** Stands in for the APNs client: records what it was asked to send, and answers by device token. */
function fakeApns(answer: (token: string) => ApnsResult = () => ({ status: 200 })) {
  const sent: { token: string; environment: string; payload: object }[] = [];
  return {
    sent,
    async send(to: PushRegistration, payload: object): Promise<ApnsResult> {
      sent.push({ token: to.token, environment: to.environment, payload });
      return answer(to.token);
    },
  };
}

const eventIds = (sent: { payload: object }[]) => sent.map((s) => (s.payload as { eventId?: number }).eventId);

/** A store with one registered phone, for the dispatcher tests. */
function storeWithPhone(): Store {
  const store = freshDevices();
  store.setPush(store.createDevice("phone").id, { token: TOKEN_A, environment: "development" });
  return store;
}

test("the push rule: an outbound app message pushes, and nothing else about messages does", () => {
  assert.ok(notificationFor(messageEvent(1, { channel: "app" })));
  assert.equal(notificationFor(messageEvent(2, { channel: "app", direction: "in" })), undefined, "an inbound message");
  assert.equal(notificationFor(runEvent(6)), undefined, "a run update");
});

test("a message of the retired channel, in the log from before, never pushes, whether it was delivered or failed", () => {
  assert.equal(notificationFor(messageEvent(3, { channel: "wechat" })), undefined, "delivered");
  assert.equal(notificationFor(messageEvent(4, { channel: "wechat", error: "ret=-2" })), undefined, "failed");
  assert.equal(notificationFor(messageEvent(5, { channel: "wechat", direction: "in", error: "x" })), undefined, "inbound");
});

/** A question.asked event; the defaults are one question for run abcdef. */
function questionEvent(id: number, questions: string[] = ["报告用哪种格式？"]): Event {
  const option = (label: string) => ({ label, description: `${label}的说明` });
  return {
    id,
    at: AT,
    type: "question.asked",
    data: {
      id: `q-${id}`,
      runId: "abcdef",
      questions: questions.map((question) => ({ question, header: "格式", options: [option("甲"), option("乙")], multiSelect: false })),
    },
  };
}

test("a question pushes with the first question as its body, and carries the event and run ids", () => {
  assert.deepEqual(notificationFor(questionEvent(21)), {
    aps: { alert: { title: "Alfred", body: "Alfred 想问你：报告用哪种格式？" }, sound: "default", "thread-id": "chat" },
    eventId: 21,
    runId: "abcdef",
  });
  assert.equal(notificationFor(questionEvent(22, ["第一个？", "第二个？"]))?.aps.alert.body, "Alfred 想问你：第一个？", "only the first question");
});

test("the question in the body is cut like other bodies: 100 characters, then an ellipsis", () => {
  const bodyOf = (question: string) => notificationFor(questionEvent(1, [question]))?.aps.alert.body;
  assert.equal(bodyOf("a".repeat(100)), `Alfred 想问你：${"a".repeat(100)}`, "exactly 100 is not cut");
  assert.equal(bodyOf("a".repeat(101)), `Alfred 想问你：${"a".repeat(100)}…`);
  assert.equal(bodyOf("好".repeat(150)), `Alfred 想问你：${"好".repeat(100)}…`, "counted in characters, not bytes");
});

test("an answer to a question does not push", () => {
  const answered: Event = { id: 23, at: AT, type: "question.answered", data: { id: "q-21", runId: "abcdef", answers: { "报告用哪种格式？": "甲" } } };
  assert.equal(notificationFor(answered), undefined);
  const cancelled: Event = { id: 24, at: AT, type: "question.answered", data: { id: "q-21", runId: "abcdef", answers: {}, cancelled: true } };
  assert.equal(notificationFor(cancelled), undefined);
});

test("a notification says Alfred, plays the default sound in the chat thread, and carries the event and run ids", () => {
  assert.deepEqual(notificationFor(messageEvent(12, { channel: "app", text: "报告好了", runId: "k7m2qa" })), {
    aps: { alert: { title: "Alfred", body: "报告好了" }, sound: "default", "thread-id": "chat" },
    eventId: 12,
    runId: "k7m2qa",
  });
  assert.deepEqual(notificationFor(messageEvent(13, { channel: "app", text: "好" })), {
    aps: { alert: { title: "Alfred", body: "好" }, sound: "default", "thread-id": "chat" },
    eventId: 13,
  });
});

test("the body is the text cut to 100 characters with an ellipsis; a file-only message shows its first file", () => {
  const bodyOf = (event: Event) => notificationFor(event)?.aps.alert.body;
  assert.equal(bodyOf(messageEvent(1, { text: "a".repeat(100) })), "a".repeat(100), "exactly 100 is not cut");
  assert.equal(bodyOf(messageEvent(2, { text: "a".repeat(101) })), `${"a".repeat(100)}…`);
  assert.equal(bodyOf(messageEvent(3, { text: "好".repeat(150) })), `${"好".repeat(100)}…`, "counted in characters, not bytes");
  assert.equal(bodyOf(messageEvent(4, { text: "", files: [{ path: "reports/报告.pdf" }, { path: "notes/a.md" }] })), "文件：报告.pdf");
});

test("a notification goes to every unrevoked device with a registration, and to no other", async () => {
  const store = freshDevices();
  const a = store.createDevice("a");
  const b = store.createDevice("b");
  store.createDevice("c"); // no registration
  store.setPush(a.id, { token: TOKEN_A, environment: "development" });
  store.setPush(b.id, { token: TOKEN_B, environment: "production" });
  store.revokeDevice(b.id);
  const apns = fakeApns();

  const outcomes = await pushToDevices(notify("hi"), store, apns);

  assert.deepEqual(apns.sent.map((s) => s.token), [TOKEN_A]);
  assert.deepEqual(outcomes.map((o) => o.deviceId), [a.id]);
});

test("a token APNs reports dead is removed from its device; other refusals keep the registration", async () => {
  const store = freshDevices();
  const dead = store.createDevice("gone");
  const badToken = store.createDevice("bad token");
  const tooLarge = store.createDevice("too large");
  const throttled = store.createDevice("throttled");
  store.setPush(dead.id, { token: TOKEN_A, environment: "development" });
  store.setPush(badToken.id, { token: TOKEN_B, environment: "development" });
  store.setPush(tooLarge.id, { token: TOKEN_C, environment: "development" });
  store.setPush(throttled.id, { token: TOKEN_D, environment: "development" });
  const answers: Record<string, ApnsResult> = {
    [TOKEN_A]: { status: 410, reason: "Unregistered" },
    [TOKEN_B]: { status: 400, reason: "BadDeviceToken" },
    [TOKEN_C]: { status: 400, reason: "PayloadTooLarge" },
    [TOKEN_D]: { status: 429, reason: "TooManyRequests" },
  };
  const apns = fakeApns((token) => answers[token] ?? { status: 200 });

  const outcomes = await pushToDevices(notify("hi"), store, apns);

  assert.deepEqual(outcomes.map((o) => o.result.status), [410, 400, 400, 429]);
  const pushOf = (id: string) => store.list().find((d) => d.id === id)?.push;
  assert.equal(pushOf(dead.id), undefined);
  assert.equal(pushOf(badToken.id), undefined);
  assert.deepEqual(pushOf(tooLarge.id), { token: TOKEN_C, environment: "development" });
  assert.deepEqual(pushOf(throttled.id), { token: TOKEN_D, environment: "development" });
});

test("with no registered device nothing is sent", async () => {
  const store = freshDevices();
  store.createDevice("nothing registered");
  const apns = fakeApns();
  assert.deepEqual(await pushToDevices(notify("hi"), store, apns), []);
  assert.equal(apns.sent.length, 0);
});

test("the reconnect wait starts at the minimum, doubles, and stops at the maximum", () => {
  const waits: number[] = [];
  let delay = 1000;
  for (let i = 0; i < 7; i++) {
    waits.push(delay);
    delay = nextDelay(delay, 30_000);
  }
  assert.deepEqual(waits, [1000, 2000, 4000, 8000, 16000, 30000, 30000]);
});

// --- The dispatcher, against a fake of Alfred's socket ---------------------

/** A fake of Alfred's command socket: GET /health and GET /events?after= as the real one answers them. */
async function fakeAlfred(socket: string, initial: Event[] = []) {
  const events: Event[] = [...initial];
  const streams = new Set<http.ServerResponse>();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://alfred");
    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return void res.end(JSON.stringify({ ok: true, lastEventId: events.at(-1)?.id ?? 0 }));
    }
    if (req.method === "GET" && url.pathname === "/events") {
      const after = Number(url.searchParams.get("after") ?? "0");
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.flushHeaders();
      for (const event of events) if (event.id > after) res.write(frame(event));
      streams.add(res);
      res.on("close", () => streams.delete(res));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  return {
    /** Appends an event and sends it to every open stream. */
    emit(event: Event) {
      events.push(event);
      for (const res of streams) res.write(frame(event));
    },
    /** A live frame: no id line, so it is never replayed or pushed. */
    emitLive(event: Event) {
      for (const res of streams) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    },
    streamCount: () => streams.size,
    /** Ends every open stream, as a restart of Alfred would. */
    dropStreams() {
      for (const res of streams) res.end();
      streams.clear();
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const res of streams) res.destroy();
        server.close(() => resolve());
      }),
  };
}

function frame(event: Event): string {
  return `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

async function waitFor(check: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${label}`);
}

/** The cursor file's id, or undefined while it does not exist. */
function cursorOf(file: string): number | undefined {
  try {
    return (JSON.parse(fs.readFileSync(file, "utf8")) as { lastEventId?: number }).lastEventId;
  } catch {
    return undefined;
  }
}

const BACKOFF = { minMs: 5, maxMs: 20 };

test("with no cursor the dispatcher starts after /health's lastEventId, so old events never push", async () => {
  const socket = path.join(tmp, "start.sock");
  const alfred = await fakeAlfred(socket, [messageEvent(1), messageEvent(2), messageEvent(3)]);
  const cursorFile = path.join(tmp, "start", "push-cursor.json");
  const apns = fakeApns();
  const signal = new AbortController();
  const done = runPushDispatcher({ socket, cursorFile, devices: storeWithPhone(), apns, signal: signal.signal, backoff: BACKOFF });
  try {
    await waitFor(() => cursorOf(cursorFile) === 3, "the cursor to start at 3");
    await waitFor(() => alfred.streamCount() === 1, "the stream to open");
    assert.equal(apns.sent.length, 0, "events 1 to 3 are old");
    alfred.emit(messageEvent(4, { text: "新的" }));
    await waitFor(() => apns.sent.length === 1, "event 4 to be pushed");
    await waitFor(() => cursorOf(cursorFile) === 4, "the cursor to move to 4");
    assert.deepEqual(eventIds(apns.sent), [4]);
  } finally {
    signal.abort();
    await done;
    await alfred.close();
  }
});

test("a restart resumes from the saved cursor, so no event is pushed twice", async () => {
  const socket = path.join(tmp, "restart.sock");
  const alfred = await fakeAlfred(socket);
  const cursorFile = path.join(tmp, "restart", "push-cursor.json");
  const store = storeWithPhone();
  const apns = fakeApns();

  const first = new AbortController();
  let done = runPushDispatcher({ socket, cursorFile, devices: store, apns, signal: first.signal, backoff: BACKOFF });
  try {
    await waitFor(() => alfred.streamCount() === 1, "the stream to open");
    alfred.emit(messageEvent(1));
    alfred.emit(messageEvent(2));
    await waitFor(() => apns.sent.length === 2, "events 1 and 2");
    await waitFor(() => cursorOf(cursorFile) === 2, "the cursor at 2");
  } finally {
    first.abort();
    await done;
  }

  alfred.emit(messageEvent(3)); // while the workbench is down

  const second = new AbortController();
  done = runPushDispatcher({ socket, cursorFile, devices: store, apns, signal: second.signal, backoff: BACKOFF });
  try {
    await waitFor(() => apns.sent.length === 3, "event 3 after the restart");
    alfred.emit(messageEvent(4));
    await waitFor(() => apns.sent.length === 4, "event 4");
    assert.deepEqual(eventIds(apns.sent), [1, 2, 3, 4], "each event once");
  } finally {
    second.abort();
    await done;
    await alfred.close();
  }
});

test("frames without an id are never pushed", async () => {
  const socket = path.join(tmp, "live.sock");
  const alfred = await fakeAlfred(socket);
  const cursorFile = path.join(tmp, "live", "push-cursor.json");
  const apns = fakeApns();
  const signal = new AbortController();
  const done = runPushDispatcher({ socket, cursorFile, devices: storeWithPhone(), apns, signal: signal.signal, backoff: BACKOFF });
  try {
    await waitFor(() => alfred.streamCount() === 1, "the stream to open");
    alfred.emitLive(messageEvent(9, { text: "live" }));
    alfred.emit(messageEvent(10, { text: "stored" }));
    await waitFor(() => apns.sent.length === 1, "event 10");
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(eventIds(apns.sent), [10]);
    assert.equal(cursorOf(cursorFile), 10);
  } finally {
    signal.abort();
    await done;
    await alfred.close();
  }
});

test("while Alfred is unreachable the dispatcher keeps trying, and after a dropped stream it resumes from the cursor", async () => {
  const socket = path.join(tmp, "late.sock");
  const cursorFile = path.join(tmp, "late", "push-cursor.json");
  const apns = fakeApns();
  const signal = new AbortController();
  const done = runPushDispatcher({ socket, cursorFile, devices: storeWithPhone(), apns, signal: signal.signal, backoff: BACKOFF });
  let alfred: Awaited<ReturnType<typeof fakeAlfred>> | undefined;
  try {
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(cursorOf(cursorFile), undefined, "no cursor while Alfred is down");
    alfred = await fakeAlfred(socket); // Alfred comes up at the path the dispatcher has been trying
    await waitFor(() => alfred?.streamCount() === 1, "the stream to open");
    alfred.emit(messageEvent(1));
    await waitFor(() => apns.sent.length === 1, "event 1");
    alfred.dropStreams();
    alfred.emit(messageEvent(2)); // while the stream is down
    await waitFor(() => apns.sent.length === 2, "event 2 after the reconnect");
    assert.deepEqual(eventIds(apns.sent), [1, 2]);
  } finally {
    signal.abort();
    await done;
    await alfred?.close();
  }
});

test("startPush says push is off and names the variables that are missing, and runs nothing", async () => {
  const lines: string[] = [];
  const log = mock.method(console, "log", (...args: unknown[]) => void lines.push(args.map(String).join(" ")));
  let stop: () => Promise<void>;
  try {
    stop = startPush({});
  } finally {
    log.mock.restore();
  }
  const line = lines.find((l) => l.includes("push is off"));
  assert.ok(line, "one line says push is off");
  assert.match(line, /ALFRED_APNS_KEY_FILE, ALFRED_APNS_KEY_ID, ALFRED_APNS_TEAM_ID, ALFRED_APNS_TOPIC not set/);
  await stop();
});
