# Client API fixtures

JSON examples of the client API defined in `src/api/schema.ts`. Alfred's tests (`src/api/schema.test.ts`) and the iOS client's Swift package tests (`ios/AlfredKit`) both read these files.

- `events/`: events Alfred stores and emits, one file per shape the client decodes, `question.asked` and `question.answered` (answered and cancelled), `task.updated`, `document.updated`, `annotation.updated` and `idea.updated` among them. Each file is a whole `Event`.
- `live/`: live events, streamed as they happen and never stored. Each file is a whole `LiveEvent`.
- `commands/`: one valid command per command shape, including a `message.send` with files, a `question.answer`, the three task commands, the two document commands and the three idea commands.
- `responses/`: bodies of the app API: `UploadResult`, `RunList`, `RunDetail`, `TaskResult`, `TaskList`, `TaskDetail`, `DocumentResult`, `DocumentList`, `DocumentDetail`, `RevisionAccepted`, `IdeaResult`, `IdeaAccepted`, `IdeaGenerationAccepted`, `IdeaList` and `ErrorResponse`. Each file is named after the schema it parses with.
- `requests/`: bodies the client sends outside the command API: `PushRegistration`.
- `pairing/`: the payload of the pairing QR code, a `Pairing`. Its values are made up.
- `invalid-commands/`: commands that `parseCommand` must reject.
- `invalid/`: off-schema files that the schema their name starts with must reject. Each is named `<schema>-<case>.json`, where `<schema>` is `pairing`, `push-registration`, `upload-result`, `run-list`, `run-detail`, `task-result`, `task-list`, `task-detail`, `document-result`, `document-list`, `document-detail`, `revision-accepted`, `idea-result`, `idea-accepted`, `idea-list` or `error`.
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

## Documents

A document is a file Alfred delivered, known by its workspace path. Delivering the same path again adds a version. `document.updated` carries the whole document on every change: a new version, a move or a new title.

- `kind` is `markdown`, `text`, `html`, `pdf`, `image` or `other`. `taskId` is set when a task's run delivered the document.
- A version is a commit of the workspace, named by its 40-character lowercase hex id. Its `reason` is `delivered` (a delivery), `revised` (the end of a revision run), `undone` (an undo) or `changed` (the end of another run that changed the file). A version of any reason but `undone` may name its `runId`. An `undone` version names the revision it undid in `undoes` and has no `runId`.
- An annotation is the owner's comment on a passage, anchored by `quote` and the text on each side of it (`prefix`, `suffix`, as W3C TextQuoteSelector), or on the whole document (`{ "kind": "document" }`). Its `version` is the version it was written on. Its `state` is `submitted` (its revision run has not answered it yet), `resolved` (answered, with its `reply`) or `returned` (back with the owner, with a `returnReason` of `unanswered`, `undone`, `stopped` or `failed`). A returned annotation that was answered before an undo keeps its `reply`.
- `annotation.updated` carries the whole annotation: one per annotation of a submitted batch, and again on every change of state or reply.
- `document.revise` submits a batch of 1 to 50 annotations against the version the owner annotated. Alfred answers 202 with a `RevisionAccepted`: the revision run and the batch, each annotation `submitted` to that run. `document.undo` names the revision run to undo and is answered 200 with a `DocumentResult`.
- `GET /api/documents` is a `DocumentList`, newest updated first. `GET /api/documents/<id>` is a `DocumentDetail`: the document, its versions (newest first, the first being the current one), its annotations and its revision runs. Revision runs carry `documentId`.
- The errors of the document commands are `ErrorResponse`: 404 for an unknown document or run, and 409 for a revise against a version that is not the current one, a second revision while one is queued or running, and an undo that is not allowed.
- `GET /api/files/<path>?version=<commit>` is the file's bytes at that version. Without `version` it is the live file.
- A file a delivery registered carries the `documentId` and the `version` it delivered: both or neither.

The `commands/` document fixtures target the story of `document-detail.json`: the owner annotates `reports/vps.md` at its current version, and the run `s2d8kp` answers the batch.

## Ideas

An idea is a suggestion Alfred generates from memory and recent conversations, once a day or when the owner asks. The owner accepts it, which creates a task with origin `idea`, rejects it with a reason, or leaves it until it is archived after 7 days. A generation is a run of kind `ideas`. Provenance is not part of the contract.

- `kind` is `once` or `recurring`. A recurring idea proposes a `schedule`, never a once one; a once idea has none. `why` is one line of 1 to 300 characters on why Alfred suggests it, and `estimateUsd` is the estimated cost of one run, from 0 to 20.
- `state` is `open`, `accepted` (with the `taskId` of the task it made), `rejected` (with a `rejection`) or `archived`. A `rejection` has a `reason` (`not-interested`, `already-doing`, `not-now`, `too-expensive` or `wrong-direction`) and an optional `note` of 1 to 500 characters.
- `idea.updated` carries the whole idea on every change of state, and a generation that adds an idea emits it too.
- `idea.accept` takes the task as the owner confirmed it in the app's task form: `title`, `brief`, `model` and `budgetUsd` as `task.create` takes them, and an optional `schedule`. Without a schedule the task is one-time and runs at once. Alfred answers 200 with an `IdeaAccepted`: the idea and the task it made.
- `idea.reject` takes a `reason` and an optional `note`, and is answered 200 with an `IdeaResult`. `idea.generate` starts a generation run, answered 202 with an `IdeaGenerationAccepted`.
- `GET /api/ideas` is an `IdeaList`: every idea, newest created first, the `generatingRunId` while a generation is queued or running, and the `lastGeneration`: the latest generation that ended, which is absent until one has.
- A `lastGeneration` (`IdeaGeneration`) has the generation's `runId` and `endedAt`, how it ended, what started it, how many ideas it added, and a note. `status` is `done`, when the model answered, or `failed`; a run that was lost (Alfred restarted) is neither, and leaves the last generation as it was. `trigger` is `requested`, when the owner asked (`idea.generate`), or `daily`, when the schedule started it. A requested generation suggests at least one idea; a daily one may add none. `added` is the number of ideas the generation added, an integer from 0 to 3. `note` is Alfred's sentence for the owner on what the generation found, and when it added none, why: 1 to 300 characters and not blank. A done generation has one; a failed one has none. It is a snapshot taken when the run ended, and no event announces it: the client reads the list again when a run of kind `ideas` ends. `responses/idea-list-nothing-new.json` is a list with no open ideas whose last generation added none, with its note; `responses/idea-list-failed.json` is a list whose last generation failed.
- The errors of the idea commands are `ErrorResponse`: 404 for an unknown idea, and 409 for an idea that is not open, a generation while one is queued or running, and a day's spend cap that is reached.

## Compatibility rules

- Clients skip events and live events whose `type` they do not know, and ignore fields they do not know.
- Alfred rejects unknown commands, and unknown keys inside a command.
- A client refuses a `Pairing` whose `version` it does not know.
