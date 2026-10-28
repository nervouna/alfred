# Ideas

An idea is a suggestion Alfred makes from memory and recent conversations, for the owner to take up as a task or turn down. Code: `src/ideas/` (the store, the only writer of `workbench/ideas.json`; commands; `generate.ts`; `schedule.ts`) and `generateIdeas` in `src/agent/handler.ts`. Command and list shapes are in `src/api/schema.ts`.

- **States.** `open` until the owner accepts it (`accepted`, with the `taskId` it made), rejects it (`rejected`, with a reason and an optional note), or leaves it unanswered for 7 days (`archived`, swept hourly). Only an open idea can be answered. The store keeps every open idea and the 200 closed ones updated last. Nothing in Alfred writes a rejection to long-term memory; only the owner telling the chat can.
- **Accepting** makes a [task](tasks.md) with origin `idea` from the title, brief, model and budget the owner confirmed. Without a schedule it is a one-time task due 60 s later, so it starts within about a minute and a half (the task poll is 30 s). The check, the task's creation and the acceptance run with no `await` between them, so two accepts cannot make two tasks. A task the store refuses (a one-time time already past) leaves the idea open.

## Generation

One short model call that reads the owner's data and adds up to three ideas. It runs daily and when the owner asks (`idea.generate`).

- **Trigger.** A `daily` generation may add none: zero is a good answer when nothing is worth suggesting. A `requested` one suggests at least one, since the owner is waiting; the prompt asks for it and the answer's JSON schema enforces `minItems: 1`.
- **Inputs** (`collectInputs`) are data, not instructions, and only what the owner and Alfred said, never tool calls, tool results or fetched pages, so a page cannot plant an idea. They are the memory index, recent messages, active and paused tasks, recent documents, earlier ideas in every state, and the cost of recent `done` task and revision runs, so estimates rest on what runs actually spent.
- **The call** is Sonnet with no tools, no saved session and `maxTurns: 3`, capped at `IDEAS_BUDGET_USD` (a constant in `src/agent/config.ts`). The answer is structured output: the ideas and a `note`, one sentence for the owner on what it found and, when it suggests nothing, why. A blank note makes the answer malformed.
- **Result.** An idea that does not map onto an `IdeaDraft` is logged and left out; the others are kept. A malformed answer or a non-success result fails the run, charged what it cost. Each idea's provenance is for the log only.
- **The run.** `generateIdeas` refuses first (503 with no store, then 409 for a shutdown, the daily cap, or a generation already running), then records a run of kind `ideas` and generates in the background. It posts no message and pushes nothing: the app learns from `idea.updated` and `run.updated`. It runs beside the chat and beside task and revision runs, using neither their lane nor the memory lock.
- **How it ends:** `done`, `failed` or `lost` (a shutdown, or a crash found at the next start). The store's `finishGeneration` runs before the run is recorded as ended, so a client told it ended already finds no `generatingRunId` and reads the outcome in `lastGeneration`. `lost` records no outcome and leaves the previous one.
- **Spend** goes into the owner's day and total like a task run's, so it counts toward the daily cap, not the chat session.

## Daily generation

`ALFRED_IDEAS_AT` ([Configuration](../README.md#configuration)) sets the time; `startDailyIdeas` checks at startup and every minute.

- A due generation at most `MISSED_RUN_MS` (6 h) late starts once, as `daily`; a later one is skipped, and so is one with 5 or more open ideas. A skip finishes the day.
- When `generateIdeas` refuses, the day stays open and the next check tries again.
- The finished day is kept in `$STATE_DIR/ideas-schedule.json`, so a restart does not run it twice.
- `scripts/app-dev.ts` starts it only with `--ideas-at`, so a development stack does not spend on its own.
