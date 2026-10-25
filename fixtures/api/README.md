# Client API fixtures

JSON examples of the client API defined in `src/api/schema.ts`. Alfred's tests (`src/api/schema.test.ts`) and the iOS client's Swift package tests both read these files.

- `events/`: events Alfred emits, one file per shape the client decodes. Each file is a whole `Event`.
- `commands/`: one valid command per command type.
- `invalid-commands/`: commands that `parseCommand` must reject.
- `future/`: events a newer Alfred might send: one with an unknown `type`, and one known event with an extra field.

Every file is pretty-printed JSON with a 2-space indent and a trailing newline. The files in `events/` and `commands/` contain only fields the schema defines; `invalid-commands/` and `future/` are off-schema on purpose.

## Compatibility rules

- Clients skip events whose `type` they do not know, and ignore fields they do not know.
- Alfred rejects unknown commands, and unknown keys inside a command.
