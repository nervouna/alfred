# Client API fixtures

JSON examples of the client API defined in `src/api/schema.ts`. Alfred's tests (`src/api/schema.test.ts`) and the iOS client's Swift package tests (`ios/AlfredKit`) both read these files.

- `events/`: events Alfred stores and emits, one file per shape the client decodes. Each file is a whole `Event`.
- `live/`: live events, streamed as they happen and never stored. Each file is a whole `LiveEvent`.
- `commands/`: one valid command per command shape, including a `message.send` with files.
- `responses/`: bodies of the app API: `UploadResult`, `RunList`, `RunDetail` and `ErrorResponse`. Each file is named after the schema it parses with.
- `requests/`: bodies the client sends outside the command API: `PushRegistration`.
- `pairing/`: the payload of the pairing QR code, a `Pairing`. Its values are made up.
- `invalid-commands/`: commands that `parseCommand` must reject.
- `invalid/`: off-schema files that the schema their name starts with must reject. Each is named `<schema>-<case>.json`, where `<schema>` is `pairing`, `push-registration`, `upload-result`, `run-list`, `run-detail` or `error`.
- `future/`: events a newer Alfred might send: one with an unknown `type`, one known event with an extra field, and one live event with an unknown `type`.

Every file is pretty-printed JSON with a 2-space indent and a trailing newline. The files in `events/`, `live/`, `commands/`, `responses/`, `requests/` and `pairing/` contain only fields the schema defines, in the schema's key order; `invalid-commands/`, `invalid/` and `future/` are off-schema on purpose.

## Live events

A live event has no `id`. Alfred sends it on the stream without an SSE `id:` line, never stores it in the event log, and so a resume never replays it. A client tells the two kinds of frame apart by the `id` key.

- The `streamId` of a `message.delta` is opaque. Every delta of one piece of assistant text carries the same one. A client concatenates the deltas of each `streamId`, and shows the latest stream of a run as that run's draft reply. An outbound `message.created` with that `runId` replaces the run's drafts.

## Compatibility rules

- Clients skip events and live events whose `type` they do not know, and ignore fields they do not know.
- Alfred rejects unknown commands, and unknown keys inside a command.
- A client refuses a `Pairing` whose `version` it does not know.
