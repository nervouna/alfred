---
name: api-contract
description: Change the client API contract between Alfred and the iOS app — a command, an event, a response or request body, or a field of one — on both sides at once. Covers the zod schema, the shared JSON fixtures and their naming, the TypeScript and Swift fixture tests, the 503 stub for commands whose service is not wired in yet, the AlfredKit model, the app API's GET routes, the compatibility rules (event log replay, strict commands, deploying the server before the app), and how a feature splits into a contract PR and the PRs on each side. Use when an issue or task adds or changes anything in `src/api/schema.ts`, `fixtures/api/` or AlfredKit's models, when writing such an issue, or when the user says 改契约、加个命令/事件/接口、API 加字段. Not for changes inside one side that leave the shapes alone.
---

# Changing the client API contract

`src/api/schema.ts` is the contract, `fixtures/api/` its examples, and `fixtures/api/README.md` the meaning of each area's shapes. Alfred's tests and AlfredKit's tests both read the fixtures, so a shape exists once and both sides test against it. `docs/api.md` is the command API's behaviour, `docs/workbench.md` the app API's routes.

## Compatibility first

Decide these before writing anything:

- **The event log is replayed from event 0** on every cold launch of the app, and the server never rewrites it. An event type or field keeps its meaning for good: add a new type or an optional field instead of changing an old one, and keep decoding what the log already holds.
- **Events and the objects they carry ignore unknown keys and types**, so a newer server can add them; clients skip an unknown event (`future/` fixtures). **Commands are strict**: the server rejects unknown types and keys. A new command or command key therefore needs the server deployed before an app that sends it, which `phone-install` checks.
- A `Pairing` with an unknown `version` is refused.

## How the work splits

A feature that needs new shapes is usually three or more issues, in this order:

1. **The contract** (one PR): schema, fixtures, tests, AlfredKit models and client calls, the 503 stub, the README section. It changes no behaviour, so it merges fast.
2. **The server** (store, service, command handling, GET route), and **the app** (screens) built on the contract's models. Once the contract is merged these touch disjoint files and can run in parallel.

Past examples: settings #194, ideas #150, documents #127.

## The contract PR, step by step

### 1. Schema (`src/api/schema.ts`)

- Add the zod schema with its limits as named constants at the top (`MAX_…`), and add a command to `CommandSchema` and an event to `EventSchema`, both discriminated unions on `type`.
- An object that also appears in responses checks only types and shapes there; ranges a command may write bind the command alone (see `Settings`).

### 2. Fixtures (`fixtures/api/`)

- **Valid** ones: `commands/` (at least one per command shape), `events/`, `live/`, `responses/`, `requests/`, `pairing/`. Each must parse and re-serialise to its exact text: pretty-printed with a 2-space indent and a trailing newline, only the schema's fields, in the schema's key order. Write the object, parse it with the schema, and save `JSON.stringify(parsed, null, 2) + "\n"`.
- A response file is named after its schema in kebab-case (`settings-detail.json`), with `-<case>` for variants (`idea-list-empty.json`).
- **Invalid** ones: `invalid-commands/` for commands `parseCommand` must reject, and `invalid/<schema>-<case>.json` for bodies the named schema must reject. Add one per rule a decoder could get wrong (a missing key, a value past its limit, a forbidden combination).
- Make the fixtures of an area tell one story: a command targets the object in the matching response, and the result is what that command would produce (`commands/rules-save.json` saves against `responses/rules.json`'s version). Say so in the README section.

### 3. Server tests

- `src/api/schema.test.ts`: add each new response schema to `SCHEMAS_BY_NAME` (the fixture and invalid tests find schemas by file name through it). Add tests for rules a fixture cannot show, and a story test when the fixtures tell one.
- `src/api/server.ts`: until the service exists, a new command is answered 503 `{"error": "<area> are not available"}` and never reaches the handler. `src/api/server.test.ts` posts each of its command fixtures and checks that.

### 4. AlfredKit (`ios/AlfredKit/Sources/AlfredKit/`)

- The model in a file of its own (`Settings.swift`, `Idea.swift`), shared enums in `Values.swift`.
- `Command.swift`: the case, encoded with the contract's keys. `Event.swift`: the case for the event type. `Timeline.swift`: the event's case in the switch, as a no-op when it is not part of the chat. `Responses.swift`: response bodies. `AlfredClient.swift`: the call that sends the command or reads the route.
- Tests: `ResponseFixtureTests` maps every response fixture by file name to its type and fails on a name it does not know, so add each new file there. Add `<Area>FixtureTests` for the values the fixtures carry, and `AlfredClientTests` for the new calls (path, method, body).

### 5. Docs

- `fixtures/api/README.md`: a section for the area with what each field means, its limits, the errors and the story the fixtures tell.
- `docs/api.md` only when the command API's behaviour changes; `docs/workbench.md` when the app API gains a route.

### 6. Check

```bash
npm run check && npm test
swift test --package-path ios/AlfredKit
xcodegen generate --spec ios/project.yml
xcodebuild -project ios/Alfred.xcodeproj -scheme Alfred -destination 'generic/platform=iOS Simulator' -derivedDataPath ios/build CODE_SIGNING_ALLOWED=NO build
```

The app build catches app code broken by a changed AlfredKit API (a new enum case in an exhaustive switch). CI runs the same (`check`, `alfredkit`, `app`).

## The server and app PRs

- **A command:** replace the 503 stub with the service call in `src/api/server.ts`, and wire the service in `src/cli.ts run` and `scripts/app-dev.ts`.
- **A GET route:** `apiRoute` in `src/workbench/server.ts`. The workbench is a separate process that cannot see Alfred's environment or memory: it reads the state dir, or a copy the store writes for it (`workbench/settings.json`).
- **An event:** append it through the event log, and decide what the app does when it replays one from long ago.
- **The app:** follow the area's catalog pattern (load the list, apply `*.updated` events, keep the newest by `updatedAt`), as `ios/README.md` describes for tasks, documents and ideas, and test it with the `app-test` skill.
