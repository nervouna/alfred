---
name: app-test
description: Run the iOS app's tests on a simulator and read their results. Covers the AlfredKit package tests, AlfredTests, and the AlfredUITests groups against a local app-dev stack (which seed each group needs, what it spends, what it changes), the PushUITests and ShareUITests extras, known flakes and failure signatures, and taking screenshots of the app. Use when a change touches `ios/`, when reviewing an iOS PR, or when the user says 跑测试、跑 UI 测试、跑 app 测试、回归、截图、截个图看看. Not for writing UI tests (`ios/AlfredUITests/CLAUDE.md`), building for or installing on the phone, or the server's `npm test`.
---

# Testing the app

What the tests check is in each test file's header; how to write one is in `ios/AlfredUITests/CLAUDE.md`. This skill is how to run them. Every simulator run goes through the global `simq` skill's queue: `simq` below is `"${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/simq/bin/simq"`.

## What to run

- CI runs none of the app's tests (`.github/workflows/ios.yml` runs `swift test` and a build), so a change under `ios/` is tested here or not at all.
- While working: `AlfredTests` and the `AlfredUITests` classes of the screens the change touches.
- Once before the PR merges: the whole suite, each group against its own stack (below). That holds one of simq's two slots for 30–54 minutes.
- `swift test --package-path ios/AlfredKit` runs the package tests on macOS (Swift 6.0). It needs no simulator and no queue.

## The simulator

Create one simulator per session and pass it to every run:

```bash
UDID=$(xcrun simctl create alfred-test com.apple.CoreSimulator.SimDeviceType.iPhone-18-Pro com.apple.CoreSimulator.SimRuntime.iOS-27-0)
```

- A new simulator boots in ~30 s (3–4 s after that) and its first-boot setup slows the whole machine for minutes, so never make one per run.
- Never boot it yourself: `simq run` boots it and shuts it down.
- Keep only the test build (`com.example.alfred`) on it. With the phone's build (`io.damao.alfred`) also installed, `ShareUITests` picks the wrong share extension.
- Keep its hardware keyboard off, or `RunsUITests` and `PushUITests` fail on `the keyboard stayed up`.

## Build

```bash
xcodegen generate --spec ios/project.yml
xcodebuild build-for-testing -project ios/Alfred.xcodeproj -scheme Alfred -destination "id=$UDID" -derivedDataPath ios/build
```

- Run `xcodegen generate` again after adding a file: a stale project runs 0 tests of it and still exits 0.
- Build with the default signing and never with `CODE_SIGNING_ALLOWED=NO`. An unsigned app has no keychain entitlement, so pairing fails (`pairing.error` 无法把配对信息存入钥匙串) and every UI test fails at the same step. `ios/README.md` uses that flag only to check that the app compiles.
- Two runs at once need two simulators and two derived-data paths: two `xcodebuild` on one path clash. A `cp -R ios/build <other path>` of the built one, run with `test-without-building -derivedDataPath <other path>`, is enough.

## The stack

`AlfredUITests` drive the app against a running `scripts/app-dev.ts` (its header lists every option). Start a fresh one in the background for each group that needs one:

```bash
S=$(mktemp -d /tmp/at.XXXXXX) && mkdir -p "$S/state" "$S/ws"
env -u CLAUDE_CODE_ENTRYPOINT ALFRED_STATE_DIR="$S/state" ALFRED_WORKSPACE="$S/ws" ALFRED_ANTHROPIC_API_KEY="$(cat <dev key file>)" \
  node scripts/app-dev.ts <seed flags> > "$S/app-dev.log" 2>&1
```

- The directories are scratch, never the deployed instance's state or workspace. The path stays short because the API socket's path must fit in about 104 bytes: that is why it is under `/tmp` and not the session's scratchpad.
- The dev key's file is named in the project memory, not in this public repo; if memory has none, ask the user. Read it in the command that starts the stack and never print it. A subagent does not inherit `ALFRED_ANTHROPIC_API_KEY`, so its brief must say this.
- `CLAUDE_CODE_ENTRYPOINT`, which a Claude Code session passes down, makes the API refuse the key.
- If another `app-dev` holds port 8787, pass `--port <n>`.
- Wait for the pairing (a `Monitor` until-loop on the log, not `sleep`), then take its JSON:

  ```bash
  PAIRING=$(grep -m1 '^\[pairing\] {' "$S/app-dev.log" | sed 's/^\[pairing\] //')
  ```

- Afterwards stop the stack and remove `$S`.

## The groups

| Group | Stack | Model | Notes |
|---|---|---|---|
| `ChatUITests`, `RunsUITests`, `QuestionsUITests`, `TasksUITests` | plain | haiku, a fraction of a cent per test | |
| `ChatHeaderUITests`, `ChatScrollUITests`, `SettingsUITests` | plain | none (`/status`, `/model` are answered by Alfred) | `SettingsUITests` changes the stack's model and leaves it on haiku |
| `ProfileUITests` | plain | none | replaces the workspace's `ALFRED.md` and leaves it so; its conflict test saves a second version through the workbench API with the pairing's device token |
| `PushUITests` | plain | none | needs the push loop (below) |
| `ShareUITests` | plain | haiku | needs a photo (below) |
| `DocumentsUITests` | `--seed-documents` | none | |
| `AnnotationsUITests` | `--seed-documents` | its second test, a few cents | |
| `MemoryUITests` | `--seed-memories` | none | renames, adds and deletes memories: a new stack every run; tests run in name order, and the last three change memories behind the app's back through the workbench API |
| `IdeasUITests` | `--seed-ideas` | none | uses up the seeded ideas: a new stack every run; tests run in name order |

The plain groups can share one stack: each test starts from the pairing screen. `ChatHeaderUITests.testTheFirstMessageIsNotCoveredByTheAvatar` gives up after 120 s of swiping back, so run it against a short history (it sorts first in the plain group).

## Run

Start every run in the background (`run_in_background`) and wait for its completion notice; the queue can hold it past the Bash tool's 10-minute limit.

```bash
TEST_RUNNER_ALFRED_PAIRING="$PAIRING" simq run --device "$UDID" -- \
  xcodebuild test-without-building -project ios/Alfred.xcodeproj -scheme Alfred -destination "id=$UDID" -derivedDataPath ios/build \
  -only-testing:AlfredUITests/ChatUITests -collect-test-diagnostics never
```

- `AlfredTests` runs the same way with `-only-testing:AlfredTests` and no pairing. Without `TEST_RUNNER_ALFRED_PAIRING` the UI tests skip themselves (the test sees `ALFRED_PAIRING`).
- Keep `-collect-test-diagnostics never`, so a failed run does not wait on diagnostics, and keep parallel testing off.
- **ShareUITests** shares the newest photo of the library. Add one before the run, not during it (an `addmedia` during the run hung the suite): `xcrun simctl addmedia "$UDID" ios/Alfred/Avatar/Clips/still.png`. The device must be booted for that, so put it inside the same `simq run`: `simq run --device "$UDID" -- bash -c 'xcrun simctl addmedia … && xcodebuild test-without-building …'`.
- **PushUITests** cannot call `xcrun simctl push` from inside the simulator. It writes `ready-<n>` into `TEST_RUNNER_ALFRED_PUSH_DIR` whenever it wants a push, with the `payload.json` to push, and a loop outside pushes it until the test writes `done`. Start the loop in the background next to the run:

  ```bash
  mkdir -p "$S/push" && rm -f "$S/push"/*
  n=1; until [ -e "$S/push/done" ]; do if [ -e "$S/push/ready-$n" ]; then xcrun simctl push "$UDID" com.example.alfred "$S/push/payload.json"; n=$((n+1)); fi; sleep 0.5; done
  ```

  and pass `TEST_RUNNER_ALFRED_PUSH_DIR="$S/push"` to the run. Stop the loop if the run ends without `done`.
- Do not load every core during a UI test (see `CLAUDE.md` on timer tests): with every core busy one test sent two messages in 500 s. A few `nice -n 10 yes` at most.

## Read the result

- Read the executed and skipped counts of every group, not only the exit status. `test-without-building` ends with `** TEST EXECUTE SUCCEEDED **`, not `** TEST SUCCEEDED **`. A group that executed 0 tests means a stale project or a missing pairing.
- Every test of a group failing at pairing, ~39 s each, is an unsigned build (Build), not the change and not the machine load: read `pairing.error` in the screen dump of the log first.
- Known first-run flakes: rerun once on the same simulator before blaming a change. They are the share tests and `SettingsUITests.test1TheTabIsTheFifthAndShowsEveryRow` on a new simulator, and `ChatUITests.testPairThenChat` as the first test against a fresh `app-dev`.
- `BUILD INTERRUPTED` or exit 143 while another session's `xcodebuild` runs is not your failure: leave the other run alone and rerun on your own simulator.
- When a test fails while the `app-dev` log shows the answer was sent, find which side lacks it with a probe (`ios/AlfredUITests/CLAUDE.md`).

## Screenshots

- `TEST_RUNNER_ALFRED_SHOTS=<dir>` makes `ChatHeaderUITests`, `ProfileUITests`, `MemoryUITests`, `AnnotationsUITests` and `IdeasUITests` save screenshots there. `ProfileUITests` and `MemoryUITests` save them in the simulator's appearance: switch with `xcrun simctl ui "$UDID" appearance dark` for the dark ones.
- For a state the app has to be driven into, add a temporary UI test that drives there and waits, take the screenshot meanwhile, and do not commit the test. Driving the simulator by hand needs the owner's grant.
- For a bare `xcrun simctl io "$UDID" screenshot <file>` after installing a differently built app, pair through a short UI test first (`ChatHeaderUITests/testTheMenuStillOffersUnpairing`): until then the notification prompt covers the chat. The first keyboard shows a "Speed up your typing" tip that needs a tap on Continue.
- Check bar and edge-effect changes in dark too (`XCUIDevice.shared.appearance` did not switch it). Judge flicker frame by frame from `xcrun simctl io "$UDID" recordVideo --codec=h264 <file>`, stopped with SIGINT.
