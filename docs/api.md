# Command API and chat semantics

How the app channel, the event log and the command API fit together, and how a running chat is steered, stopped and asked questions. Code: `src/channels.ts`, `src/events.ts`, `src/api/` (`schema.ts` is the contract, `fixtures/api/` its examples), intake in `src/agent/handler.ts`.

## Channel and event log

- **One channel, one queue.** The app is the only channel. The command API is its client and calls the handler's `submit`, `stopRun` and `answerQuestion` (`Intake`); one queue takes messages in arrival order.
- **The event is the delivery.** Every message in either direction is recorded as `message.created` in `events/events.jsonl`: append-only, ids grow by one, kept for good. A note a message triggers (runs a restart cut short, the daily cap) is a message of its own, recorded after the owner's. The log keeps the retired `wechat` channel's messages; nothing writes to it.
- **Live events** (`message.delta`, the reply as it is written; `run.step`) go out on the stream without an id and are never stored or replayed.

## The socket

`ALFRED_API_SOCKET` ([Configuration](../README.md#configuration)) is a Unix socket, 0600, no TCP. `npm start` refuses to start with it off. The workbench's `/api/` forwards to it ([workbench](workbench.md)).

- **`POST /commands`** takes a JSON command, checked by `parseCommand` first; unknown types and keys fail. Errors are `{"error": "…"}` with a 4xx, and nothing reaches the handler. Task, document, idea, settings, rules and memory commands ([tasks](tasks.md), [documents](documents.md), [ideas](ideas.md), settings below, [agent](agent.md#workspace-rules-alfredmd), [agent](agent.md#long-term-memory)) answer 503 when their store or service is not wired in; `src/cli.ts run` and `scripts/app-dev.ts` wire them all, the documents only when they started.
- **`settings.update`** sets or resets any of the eight settings (`Settings` in `schema.ts`) and answers 200 `{"settings": …}`, the effective values after it. The overrides are kept in `settings.json` in the state dir and win over the environment, which wins over the built-in default; a reset removes the override, so the value returns to the environment's, and the model's to `sonnet`. The ranges in `schema.ts` bind what a command may write, not the environment: a deployment's `ALFRED_DAILY_BUDGET_USD=150` is the effective value as it is. A command's model, if it changes, goes through the handler's model switch (what `/model` does), then the rest is applied, so one command is one event. A change takes effect without a restart, at the next use of the value ([agent](agent.md#spend)); the agent has no tool for it, and the socket is out of its reach.
- **`settings.updated`** is appended with the whole `Settings` whenever an effective value changes: by `settings.update`, or by `/model`. A command that leaves every value as it was appends nothing and writes nothing. `GET /api/settings` on the workbench ([workbench](workbench.md#the-apps-api)) reads the effective values from the copy the store keeps for it.
- **`message.send`** carries a `clientId`; the last 1000 are remembered, in memory only, so a repeat is answered `duplicate` and a restart forgets them. Its files must be in the inbox already. They attach to the next text message, and a message with files and no text is answered `已保存 …，告诉我要怎么处理。`.
- **`POST /uploads?name=`** saves the body into `inbox/<local date>/` under a sanitized, unique name, written to a temporary name and renamed when complete, so a cut-short upload leaves nothing. It records no event; the message that names the file does.
- **`GET /events`** resumes after `Last-Event-ID`, else `?after=`, else the start: backlog first, then new events, with no gap or repeat at the switch. It sends `: ping` as it opens and every 30 s. The first ping matters: Cloudflare holds response headers until the first body byte, and the app counts the stream as connected on the headers, so a start with no backlog would wait a heartbeat. The backlog ends with an `event: caught-up` frame that has no id and carries `{}`, sent once per stream (also when there was nothing to catch up on), so a client can apply the backlog in one piece; a client that does not know the frame skips it.
- **`GET /health`** answers `{"ok": true, "lastEventId": n}`.

## Steering and stopping

One task runs at a time. A message sent during it is acknowledged (`收到，会在当前步骤结束后转给 Alfred。`) and pushed into the run's live input (`src/agent/input.ts`). Claude Code folds it into the running turn at the next tool-round boundary, or runs it as a turn of its own after the current one; each turn gets a reply. A tool call in flight is not cut off. Unanswered follow-ups and queued messages, and attachments waiting for a text message, live in memory only and are lost on a restart.

- **The task ends** when every message is answered and no background subagent is running or queued. A message after that is queued and starts the next task, which resumes the same session; none is lost between.
- **`/stop` and `run.stop`** interrupt only the current turn (`Query.interrupt()`): background subagents and waiting messages go on, and the reply says which. If the turn has not ended 10 s later (`INTERRUPT_GRACE_MS`), the run is aborted, which also drops its subagents and unanswered follow-ups. With a run id they stop that background subagent, take a queued one out, or abort a scheduled task's or a revision run, live or queued.

## Questions

The main agent (a subagent's call is denied at once: only Alfred talks to the owner) can ask a few-option question with the SDK's `AskUserQuestion`. The app shows it from `question.asked`; the run waits with no timeout, and it pushes ([workbench](workbench.md#push)).

- **Answering.** `question.answer` keys its answers by the questions' texts. Any message that is not a slash command also answers an open question, as free text: the trimmed text answers every question of the ask. It is not a follow-up. A file-only message does not answer.
- **Why a hook.** `src/agent/questions.ts` holds the call in a `PreToolUse` hook, which allows it with the answers added to the tool's input. `canUseTool` cannot do it: under `dontAsk` the CLI denies the tool before `canUseTool` is asked, and offers it only when a `canUseTool` is set at all, so the options carry `denyPermissionPrompts`, which should never be asked. The hook's timeout is a week (`QUESTION_HOOK_TIMEOUT_SECONDS`) because the SDK's default for a callback hook, 600 s, would cut a question off: a timed-out `PreToolUse` callback blocks the tool call.
- **Cancelling.** `/stop`, `run.stop`, the call's abort signal, the end of the run and shutdown record `question.answered` with `cancelled: true` and deny the call with "The user stopped the run".
