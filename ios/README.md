# iOS client

`AlfredKit/` is a Swift package with the client's Codable model of the API, tested on the shared fixtures in `fixtures/api/`. `Alfred/` is the app, `AlfredShare/` its Share Extension, `Shared/` the code both compile, `Config/` the build settings. `project.yml` is the XcodeGen spec; the `.xcodeproj` is generated and not committed. Needs Xcode 27 and XcodeGen (`brew install xcodegen`). Gotchas from working here are in `CLAUDE.md`.

## The app

Four tabs: 对话 (chat), 任务 (tasks and recent runs), 文档 (documents) and 想法 (ideas). `AppModel` (`App/`) owns the credentials, the event stream, the `Timeline` and the owner's sends; views only read it through the SwiftUI environment. The task, document and idea catalogs load their list and apply `*.updated` events; an item takes the version with the newest `updatedAt`, so a list read before an event cannot undo it.

- **Chat.** A pending message is dimmed until its echo arrives, and a failed send is retried with the same `clientId`. The chat has no stop button: sending `/stop` as a message stops the chat's run. A scheduled task's run is not the chat's, so its draft and steps stay out and a banner above the composer shows it. A file chip opens the document at the version the message delivered (`FileRef.documentId` and `.version`). Messages of the retired WeChat channel are tagged `微信`.
- **Header.** `Chat/ChatHeader.swift` replaces the navigation bar with a bar as tall as the system's inline one, read from UIKit (`SystemBar.inlineHeight`); the avatar hangs below it, drawn by `ChatHeaderOverlay`.
- **Tasks.** Schedules show in the owner's zone (`TaskList.timeZone`), not the phone's.
- **Ideas.** 采纳 opens the task form filled in from the idea (`TaskForm(accepting:)`); a one-off idea gets a 立即 kind that sends no schedule. 讨论 only puts the brief into the composer (`AppModel.composerText`). The badge counts open ideas not yet seen (`SeenIdeas` in `UserDefaults`); ideas never push. A line above the list explains a generation that added nothing, from `lastGeneration`.
- **Annotating.** Selecting text in one block of the current version of a Markdown or text document offers `批注` in the edit menu; the text is a UIKit text view (`PassageText`) because SwiftUI `Text` does not expose the selection. `整篇批注` works on every kind; passages in HTML and PDF are not annotated yet (#120). A passage is the quote plus up to 32 scalars of prefix and suffix, which `AnchorText.locate` uses to re-anchor it on another version. Drafts live in `Application Support/Alfred/annotation-drafts.json`. 提交 sends up to 50 as one `document.revise`; a 409 reloads the document and keeps the drafts.
- **Viewer.** A file is downloaded (`GET /api/files/<path>`, `?version=` for a version) and shown by extension (`FileViewerKind`): Markdown, PDFKit, images, monospaced text (256 KB), HTML and SVG in the isolated web view, else QuickLook.
- **Report isolation.** HTML runs in a web view kept away from the app: a non-persistent data store, no script message handler, a content rule list that blocks every load except the document and `data:` URLs (a report whose list fails to compile is not shown), and a load from a string with a `nil` base URL whose navigation delegate cancels every navigation after it.
- **Avatar.** `working` while a chat run runs, `standingBy` otherwise. `AvatarDirector` (pure, with an injected random source and clock) picks the clip: idle clips after 8 to 20 seconds, or `work-start`, `work-loop`, `work-end`. The clips are H.264 files without audio in `Alfred/Avatar/Clips/` (`xcodegen` bundles whatever is there), with `still.png` and `typing.png` for the two poses. `AvatarPlayer` never shows a video layer that has not drawn: an opaque cover with the picture of the pose the clip starts on stays up until the lane has drawn.

## Pairing

One QR code carries the server URL, the Cloudflare Access service token and the device token. Scan it (VisionKit, where there is a camera) or paste the pairing JSON with `粘贴配对信息`, the way in on the simulator and in UI tests; the whole `[pairing] {…}` line `app-dev` prints works. The app checks it with `GET /api/ping` and only then saves it. `取消配对` in the chat menu deletes it.

The credentials are one keychain item (service `alfred`) in the group named by the `AlfredKeychainAccessGroup` Info.plist value, which the Share Extension reads too. The simulator's keychain refuses an unsigned app (`errSecMissingEntitlement`, -34018): build the app under test with the default signing, as the test commands do; `CODE_SIGNING_ALLOWED=NO` only checks that it compiles.

## Event stream, attachments, questions

The app follows `/api/events` from the `Timeline`'s last event id while the scene is active; a background scene drops the stream and the next foreground resumes from the same id. Each connect also reads the task and idea lists again.

The composer takes photos and files: at most 10 files of 50 MiB (`AttachmentLimits`). A photo Claude cannot read (HEIC, HEIF, TIFF, RAW) becomes a JPEG with ImageIO (`PhotoExport`). Files upload one after another (`POST /api/uploads`), then `message.send` names them; a retry uploads only the failed ones.

A `question.asked` event is a card in event order. With one single-select question a tap on an option sends `question.answer` at once; otherwise `提交` sends all answers, a multi-select question's labels joined by `, `. A run that ends with the question open closes it.

## Push

The workbench pushes through APNs for Alfred's messages and questions (`src/workbench/push.ts`); the payload carries `eventId` and, when there is one, `runId`.

- **Registering.** After pairing and at each launch while paired, the app asks for permission and registers. The token goes to `POST /api/push` as lowercase hex with the environment from the `AlfredAPNsEnvironment` Info.plist key, which `project.yml` sets to `development` to match the development-signed Release build and its `aps-environment` entitlement; without the key nothing registers. Unpairing calls `unregisterForRemoteNotifications`, but the server keeps the registration until the device is revoked.
- **Foreground.** No banner while the chat tab is on screen.
- **A tap** opens the chat at the event `eventId` names. A fresh list can lose an early scroll, so the chat repeats it every 100 ms (up to 40 times) until the row stays on screen.

To see a notification on the simulator, push a payload shaped like the server's while the app is in the background:

```bash
cat > payload.json <<'EOF'
{"aps":{"alert":{"title":"Alfred","body":"报告写好了"},"sound":"default","thread-id":"chat"},"eventId":42,"runId":"k7m2qa"}
EOF
xcrun simctl push <udid> com.example.alfred payload.json
```

## Share Extension

Shares one web page, PDF or image: the activation rule in `project.yml` lets through exactly one item with exactly one such attachment. A page is one `message.send` (the note, a blank line, the title cut to 300 characters, the address); only `http` and `https` are pages. A PDF or image is copied by the file system into the extension's scratch area (never read into memory, an extension has little of it), uploaded with `upload(fileAt:)` and named in a `message.send`. A retry keeps the client id and uploads nothing twice (`ShareModel`).

## Build

For the simulator:

```bash
xcodegen generate --spec ios/project.yml
xcodebuild -project ios/Alfred.xcodeproj -scheme Alfred -destination 'generic/platform=iOS Simulator' -derivedDataPath ios/build CODE_SIGNING_ALLOWED=NO build
```

For the phone, the owner's signing settings are not in the repo: copy `Config/Signing.example.xcconfig` to `Config/Signing.xcconfig` (git ignores it) and fill in the team id and bundle id. `Base.xcconfig` includes it, so it applies to every configuration.

```bash
xcodebuild -project ios/Alfred.xcodeproj -scheme Alfred -configuration Release -destination 'generic/platform=iOS' -derivedDataPath ios/build -allowProvisioningUpdates build
xcrun devicectl device install app --device <name> ios/build/Build/Products/Release-iphoneos/Alfred.app
```

The first install needs the developer trusted on the phone (Settings > General > VPN & Device Management); reinstall when the profile expires.

## Run against a local Alfred

`node scripts/app-dev.ts` runs the real handler behind the command API, and the workbench on `http://127.0.0.1:8787` without TLS. Point `ALFRED_STATE_DIR` and `ALFRED_WORKSPACE` at new scratch directories and set `ALFRED_ANTHROPIC_API_KEY`. Keep the state path short: the Unix socket path must fit in about 104 bytes. It prints the pairing as one `[pairing]` line to paste into the app; `--repair` pairs a new device. Messages other than commands run the model. The header of `scripts/app-dev.ts` lists every option, including the `--seed-*` ones the suites below use.

## Test

`swift test --package-path ios/AlfredKit` runs the package tests on macOS (Swift 6.0). The app has two test targets in the `Alfred` scheme. Use a simulator of your own (`xcrun simctl create "alfred-test" com.apple.CoreSimulator.SimDeviceType.iPhone-18-Pro com.apple.CoreSimulator.SimRuntime.iOS-27-0` prints its id) and `-collect-test-diagnostics never`, so a failed run does not wait on diagnostics.

```bash
xcodebuild test -project ios/Alfred.xcodeproj -scheme Alfred -destination 'id=<udid>' -derivedDataPath ios/build -only-testing:AlfredTests -collect-test-diagnostics never
```

`AlfredUITests` drive the app against a running `app-dev`: copy the JSON of its `[pairing]` line and pass it as `TEST_RUNNER_ALFRED_PAIRING` (the test sees `ALFRED_PAIRING`). Without it the tests skip themselves; each starts from the pairing screen, so a stack can be reused.

```bash
TEST_RUNNER_ALFRED_PAIRING='{"version":1,…}' xcodebuild test -project ios/Alfred.xcodeproj -scheme Alfred -destination 'id=<udid>' -derivedDataPath ios/build -only-testing:AlfredUITests -collect-test-diagnostics never
```

- **Plain `app-dev`:** `ChatUITests`, `RunsUITests`, `QuestionsUITests`, `TasksUITests`, `ChatHeaderUITests`, `PushUITests`, `ShareUITests`. Most run the model on haiku, a fraction of a cent per test; `ChatHeaderUITests` and `PushUITests` run none (`/status` is answered by Alfred itself).
- **`--seed-documents`:** `DocumentsUITests` (no model) and `AnnotationsUITests` (its second test runs the model, a few cents).
- **`--seed-ideas`:** `IdeasUITests` runs no model but uses up the seeded ideas, so each run needs a new `ALFRED_STATE_DIR` and `ALFRED_WORKSPACE`; its tests run in name order.
- **`TEST_RUNNER_ALFRED_SHOTS`**, a directory, makes `ChatHeaderUITests`, `AnnotationsUITests` and `IdeasUITests` save screenshots there.
- **`ShareUITests`** shares the newest photo of the library: add one first with `xcrun simctl addmedia <udid> <image>`.
- **`PushUITests`** cannot call `xcrun simctl push` from inside the simulator, so a loop outside it does: the test writes `ready-<n>` into `TEST_RUNNER_ALFRED_PUSH_DIR` whenever it wants a push, and the loop pushes the `payload.json` the test wrote there.

```bash
# shell 1: the test
mkdir -p /tmp/push-check && rm -f /tmp/push-check/*
TEST_RUNNER_ALFRED_PUSH_DIR=/tmp/push-check TEST_RUNNER_ALFRED_PAIRING='{"version":1,…}' xcodebuild test -project ios/Alfred.xcodeproj -scheme Alfred -destination 'id=<udid>' -derivedDataPath ios/build -only-testing:AlfredUITests/PushUITests -collect-test-diagnostics never
# shell 2: pushes whenever the test asks, until it is done
n=1; until [ -e /tmp/push-check/done ]; do if [ -e /tmp/push-check/ready-$n ]; then xcrun simctl push <udid> com.example.alfred /tmp/push-check/payload.json; n=$((n+1)); fi; sleep 0.5; done
```

## Continuous integration

`.github/workflows/ios.yml` runs on changes to `ios/` and `fixtures/`: an `alfredkit` job runs `swift test`, and an `app` job builds the simulator target on `macos-26`. No runner has Xcode 27 yet, so it picks the newest installed one and overrides `IPHONEOS_DEPLOYMENT_TARGET` (`project.yml` stays at 27.0); remove the override once a runner has Xcode 27. CI does not run the app's tests.
