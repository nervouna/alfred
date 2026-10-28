# Tasks

A task is a brief the agent runs on a schedule, unattended. Code: `src/tasks/` (the store, the only writer of `workbench/tasks.json`, and the schedule arithmetic), `runTaskRun` in `src/agent/handler.ts`, `src/agent/task-tools.ts`. Command shapes are in `src/api/schema.ts`. Origins: `manual`, `chat`, `idea` (an accepted [idea](ideas.md)).

- **Schedules.** Once, daily, weekly on chosen weekdays, or every N hours; no cron. Times of day are in the process's time zone (`TZ`, also the daily cap's), so a phone in another zone moves nothing and daylight saving does not move the time of day.
- **Due and missed.** At startup (after runs a restart cut short are marked lost) and every 30 s, the handler asks the store for due runs. The store moves a task to its next time as it hands a run over, so a run cut short by a restart is never rerun. A run missed by up to `MISSED_RUN_MS` (6 h) runs once; older misses are skipped, and several in a row run at most once. Skips (`missed`, `daily-cap`) are recorded on the task, with no message. A one-time task is done once its run is taken.
- **Beside the chat.** Due runs wait in one queue, shared with revision runs ([documents](documents.md)), and one goes at a time, never holding up or stopping the chat. A run now (`task.run`) joins it, leaves the schedule alone, and runs even if the task is paused.
- **Unattended.** A run of kind `task` with a `taskId`, on the task's model and per-run cap (`budgetUsd`, default $2, at most $20), through the chat's `execute` and `agentOptions`, except:
  - a fresh session with `persistSession: false`, so it is never memory-scanned;
  - no `AskUserQuestion` and no task tools;
  - background `Agent` calls are denied with a reason telling the agent to call again in the foreground;
  - `memory/`, `skills/` and `ALFRED.md` files are read-only for the run and its subagents;
  - the first message is `taskPrompt` (due time, nobody watching, where the report goes, the previous report) then the brief.
- **Spend.** Counts toward the daily cap, not the chat session. With the cap reached, a run does not start: a scheduled occurrence is skipped (`daily-cap`) and one message says so.
- **Delivery.** Everything the run says is a `message.created` with the run and task ids and pushes like any reply (no quiet mode). An error result, the budget cap included, ends it failed with one message; `run.stop` ends it stopped with none. A run live at shutdown or a crash is lost, and its occurrence is not rerun.
- **The chat hears of it.** The 20 newest task runs that delivered a reply are kept as `taskDeliveries` in `agent-state.json`; the owner's next plain message carries them as data and clears them. A failed run is not a delivery.
- **Pausing and ending** go through the store's `update`, whose `onStatusChange` is the one place the handler reacts: the live run is aborted (stopped, no message) and every queued run of the task is dropped, scheduled or run now, with no skip recorded. Resuming does not bring them back. The `done` a one-time task gets as its run is taken is not such a change, so that run goes on.

## From chat

The main agent of a chat run has `task_list`, `task_create` and `task_update`; task runs do not, and a subagent's call is denied.

- **What asks for the owner's tap:** a new task, a change to `brief`, `schedule`, `model` or `budgetUsd`, and resuming. Pausing, ending, a new title and a call that changes nothing do not. So nothing the agent reads can plant or change a recurring task on its own.
- **The confirmation** is a structured question (header `新任务` or `改任务`, options `确认` and `不要`; see [api](api.md)) whose text Alfred writes from the call's arguments, never the agent's words: title, schedule with time zone, model, cap, brief, and for a change only the changed fields, old → new. Only `确认` applies it. `不要`, any other free text (back to the agent as the owner's words, even "好的") and a cancel leave the task as it was.
