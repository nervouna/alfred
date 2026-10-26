# Client API fixtures

JSON examples of the client API defined in `src/api/schema.ts`. Alfred's tests (`src/api/schema.test.ts`) and the iOS client's Swift package tests (`ios/AlfredKit`) both read these files.

- `events/`: events Alfred stores and emits, one file per shape the client decodes, `question.asked` and `question.answered` (answered and cancelled) and `task.updated` among them. Each file is a whole `Event`.
- `live/`: live events, streamed as they happen and never stored. Each file is a whole `LiveEvent`.
- `commands/`: one valid command per command shape, including a `message.send` with files, a `question.answer` and the three task commands.
- `responses/`: bodies of the app API: `UploadResult`, `RunList`, `RunDetail`, `TaskResult`, `TaskList`, `TaskDetail` and `ErrorResponse`. Each file is named after the schema it parses with.
- `requests/`: bodies the client sends outside the command API: `PushRegistration`.
- `pairing/`: the payload of the pairing QR code, a `Pairing`. Its values are made up.
- `invalid-commands/`: commands that `parseCommand` must reject.
- `invalid/`: off-schema files that the schema their name starts with must reject. Each is named `<schema>-<case>.json`, where `<schema>` is `pairing`, `push-registration`, `upload-result`, `run-list`, `run-detail`, `task-result`, `task-list`, `task-detail` or `error`.
- `future/`: events a newer Alfred might send: one with an unknown `type`, one known event with an extra field, and one live event with an unknown `type`.

Every file is pretty-printed JSON with a 2-space indent and a trailing newline. The files in `events/`, `live/`, `commands/`, `responses/`, `requests/` and `pairing/` contain only fields the schema defines, in the schema's key order; `invalid-commands/`, `invalid/` and `future/` are off-schema on purpose.

## Live events

A live event has no `id`. Alfred sends it on the stream without an SSE `id:` line, never stores it in the event log, and so a resume never replays it. A client tells the two kinds of frame apart by the `id` key.

- The `streamId` of a `message.delta` is opaque. Every delta of one piece of assistant text carries the same one. A client concatenates the deltas of each `streamId`, and shows the latest stream of a run as that run's draft reply. An outbound `message.created` with that `runId` replaces the run's drafts.

## Questions

Alfred asks the owner a question mid-run with `question.asked` and records how it ended with `question.answered`; the app answers with the `question.answer` command.

- A `question.asked` has an `id` of 1 to 64 characters of `[A-Za-z0-9_-]`, the `runId` that waits, and one to four `questions`, each with its `question` text, a short `header`, two to four `options` (`label` and `description`) and `multiSelect`.
- `answers` maps a question's text to its answer: an option's label, the labels of several joined with `, ` for a multi-select question, or free text. A `question.answered` with `cancelled: true` has no answers: a stop cancelled it.
- A `question.answer` needs at least one answer, each 1 to 2000 characters, keyed by a question's text. Alfred answers 404 when the question is not open and 400 when a key is not one of its questions' texts.
- A client keeps the open questions by `id`: `question.asked` adds one, `question.answered` removes it.

## Tasks

A task is a brief the agent runs on a schedule. Alfred emits `task.updated` with the whole task on every change, including `nextRunAt`, `lastRunId`, `lastRunAt` and `skips`. A run, or a message a run delivered, names its task with `taskId`.

- `schedule.kind` is `once` (at an ISO timestamp), `daily` (at a time), `weekly` (`days` then a time) or `interval` (`hours`). A time is `HH:MM` from `00:00` to `23:59`. `days` are 1 to 7, 1 being Monday, in strictly ascending order. `hours` are 1 to 168.
- Schedules are computed in the zone `timeZone` that `GET /api/tasks` names. A task list is newest created first, and a task detail's runs are newest first.
- `nextRunAt` is present only while the task is `active`.
- `skips` are the runs a task missed (`missed`) or skipped because the day's spend cap was reached (`daily-cap`), newest first.
- `task.create` leaves the model and budget to Alfred's defaults when the command omits them. `task.update` changes at least one field besides `taskId`, and `task.run` runs the task now without moving its next scheduled time.

## Compatibility rules

- Clients skip events and live events whose `type` they do not know, and ignore fields they do not know.
- Alfred rejects unknown commands, and unknown keys inside a command.
- A client refuses a `Pairing` whose `version` it does not know.
