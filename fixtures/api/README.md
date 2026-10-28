# Client API fixtures

JSON examples of the client API defined in `src/api/schema.ts`. Alfred's tests (`src/api/schema.test.ts`) and the iOS client's Swift package tests (`ios/AlfredKit`) both read these files.

- `events/`: events Alfred stores and emits, one file per shape the client decodes, `question.asked` and `question.answered` (answered and cancelled), `task.updated`, `document.updated`, `document.removed`, `annotation.updated`, `idea.updated` and `settings.updated` among them. Each file is a whole `Event`.
- `live/`: live events, streamed as they happen and never stored. Each file is a whole `LiveEvent`.
- `commands/`: one valid command per command shape, including a `message.send` with files, a `question.answer`, the three task commands, the two document commands, the three idea commands, the settings command, `rules.save` and the three memory commands.
- `responses/`: bodies of the app API: `UploadResult`, `RunList`, `RunDetail`, `TaskResult`, `TaskList`, `TaskDetail`, `DocumentResult`, `DocumentList`, `DocumentDetail`, `RevisionAccepted`, `IdeaResult`, `IdeaAccepted`, `IdeaGenerationAccepted`, `IdeaList`, `Rules`, `MemoryList`, `MemoryResult`, `SettingsResult`, `SettingsDetail` and `ErrorResponse`. Each file is named after the schema it parses with.
- `requests/`: bodies the client sends outside the command API: `PushRegistration`.
- `pairing/`: the payload of the pairing QR code, a `Pairing`. Its values are made up.
- `invalid-commands/`: commands that `parseCommand` must reject.
- `invalid/`: off-schema files that the schema their name starts with must reject. Each is named `<schema>-<case>.json`, where `<schema>` is `pairing`, `push-registration`, `upload-result`, `run-list`, `run-detail`, `task-result`, `task-list`, `task-detail`, `document-result`, `document-list`, `document-detail`, `revision-accepted`, `idea-result`, `idea-accepted`, `idea-list`, `memory-list`, `memory-result`, `settings-result`, `settings-detail` or `error`.
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

- A document the agent deletes, by moving its file into `.trash/`, is announced with `document.removed` instead, whose data is the document's `id`: Alfred sends it when the file goes into `.trash/` from outside it, and nothing when a file moves within `.trash/`. A client removes the document and its annotations. `GET /api/documents` leaves out a document in `.trash/`, and `GET /api/documents/<id>` answers 404 for it. Moving the file back out is a restore: Alfred sends `document.updated` with the whole document, which has the id, versions and annotations it had.
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

## Rules

The owner reads and edits the root `ALFRED.md`, the workspace rules, in the app. `GET /api/rules` is a `Rules`: the file's `text`, its `version` and `maxBytes`.

- `text` is the file decoded as UTF-8, as it is. A missing file, and one that is a symlink or not a regular file, reads as empty text. A file over 65 536 bytes is answered 413 with an `ErrorResponse`, so an editor never holds a cut-off text.
- `version` is the lowercase hex sha256 of the file's bytes, of the empty string when the file is missing or reads as empty. `maxBytes` is 8192: the most a saved text may hold, in UTF-8 bytes, being what of the file reaches the agent's system prompt.
- `rules.save` replaces the file with `text`, stored as sent, and is answered 200 with the new `Rules`. Its `version` is the one the owner read, so a client saves against the `Rules` it edited. Any other `version` is a conflict: the client reads again.
- The errors are `ErrorResponse`: 400 for a text over `maxBytes` of UTF-8 or with a NUL, and 409 for a version that is not the file's current one, or when `ALFRED.md` is a symlink, not a regular file or over 65 536 bytes: Alfred never replaces those. `rules.save` is answered 503 until Alfred has the rules service.

The `commands/rules-save.json` fixture saves an edit of the text of `responses/rules.json`, against its version.

## Memory

Alfred's long-term memories are Markdown files in the workspace's `memory/`, one fact each. The owner lists, adds, edits and deletes them in the app. `GET /api/memories` is a `MemoryList`.

- A `Memory` has `file` (its name in `memory/`), `name`, `description`, `kind`, `updated`, `body` and `version`. `kind` is the memory's type as a plain string: `user`, `preference`, `project` or `correction`, or, for a file written before the kinds were fixed, any other string or "". `updated` is the local date the file was last written, `YYYY-MM-DD`, or "" when it has none. `version` is the lowercase hex sha256 of the file's bytes: an update or a delete names the version the owner read.
- A `MemoryList` has the `memories`, most recently updated first (a tie by name, a memory with no date last), in the order of the index in Alfred's system prompt, and `promptCount`: how many of the first memories fit that index under its caps (200 lines or 8 KB). Those are in Alfred's prompt and the rest are not, so `promptCount` is at most the number of memories. A file in `memory/` that is not kebab-case ASCII (the agent may write one) is listed, and cannot be updated or deleted from the app.
- `memory.create` takes `name` (1 to 80 characters), `description` (0 to 200), `kind` (`user`, `preference`, `project` or `correction`) and `body` (at most 8192 bytes of UTF-8, no NUL). `name` and `description` are one line: trimmed, with no control character. Alfred names the file from the name: its lowercase ASCII letters and digits with hyphens between, or `memory-<YYYYMMDD>-<4 characters>` when it has none (a Chinese name, for one), and `-2`, `-3` and on when the file exists. It answers 201 with a `MemoryResult`: the `memory` as its file now holds it.
- `memory.update` takes the `file` (a name of the form above), the `version` read, and the four fields as `memory.create` takes them. It rewrites the file, dates it today, and keeps the five known fields and no other. It answers 200 with a `MemoryResult`.
- `memory.delete` takes the `file` and the `version` read, and moves the file to `.trash/memory/`. It answers 200 with `{ "deleted": true }`. Nothing removes a file for good.
- The errors are `ErrorResponse`: 400 for a value the contract refuses, 404 for an unknown `file`, and 409 for a `version` that is not the file's current one (the client reads again) and when Alfred is tidying memory: a memory scan holds the memory lock for more than 3 seconds, and the client tries again shortly. The commands are answered 503 until Alfred has the memory service.

`commands/memory-update.json` edits the first memory of `responses/memory-list.json` against its version, and `responses/memory-result.json` is its answer. `commands/memory-delete.json` deletes the fourth. The list's `promptCount` is smaller than its length, and its last memory has an older kind and no date.

## Settings

The owner's settings are Alfred's tunables: Alfred reads them from its environment when it starts, and the owner can override them from the app. The precedence is the built-in default, then the environment variable, then the owner's override. The contract carries only the effective values.

- `Settings` has all eight keys, in the table's order: `model` (`sonnet`, `opus` or `haiku`, the chat's model), `dailyBudgetUsd` (spend per day), `runBudgetUsd` (spend cap of one chat run), `sessionIdleHours` (idle hours before a new session; 0 turns rotation off), `compactTokens` (an integer: the context size that triggers compaction; 0 keeps Claude Code's own window), `memoryScanMinutes` (minutes between memory scans; 0 turns them off), `memoryScanBudgetUsd` (spend cap of one scan) and `ideasAt` (the `HH:MM` time of the daily idea generation, or `null` when it is off).
- `overridden` names the keys the owner has set to something other than the default, in the table's order, each once. For `model` that means not `sonnet`. A value that comes from the environment is not an override.
- `settings.update` changes any subset of the eight keys, where `ideasAt` set to `null` turns the generation off, and `reset`: a non-empty list of distinct keys to return to their defaults. It needs at least one setting or reset, and a key may not be both set and reset. It is strict, as the other commands are.
- The ranges are those a command may set: `dailyBudgetUsd` from 1 to 100, `runBudgetUsd` from 1 to 20, `sessionIdleHours` from 0 to 168, `compactTokens` 0 or from 20000 to 1000000, `memoryScanMinutes` from 0 to 1440, `memoryScanBudgetUsd` above 0 and at most 1, `ideasAt` an `HH:MM` time or `null`, and `model` one of the three. The ranges bind the command only. A deployment may run with a value beyond them (`ALFRED_DAILY_BUDGET_USD=150`), so a `Settings` in a response checks the types and the `HH:MM` shape alone.
- `settings.updated` carries the whole `Settings` on every change of an effective value. `settings.update` is answered 200 with a `SettingsResult`: the `settings` as Alfred now holds them. `GET /api/settings` is a `SettingsDetail`: the `settings` and `spentTodayUsd`, the owner's spend today in the owner's time zone, 0 or more.

## Compatibility rules

- Clients skip events and live events whose `type` they do not know, and ignore fields they do not know.
- Alfred rejects unknown commands, and unknown keys inside a command.
- A client refuses a `Pairing` whose `version` it does not know.
