# iOS client

`AlfredKit/` is a Swift package with the client's Codable model of the API, tested on the shared fixtures in `fixtures/api/`. `Alfred/` is the app, `AlfredShare/` its Share Extension, `Shared/` the code both compile, `Config/` the build settings. `project.yml` is the XcodeGen spec; the `.xcodeproj` is generated and not committed. Needs Xcode 27 and XcodeGen (`brew install xcodegen`). Gotchas from working here are in `CLAUDE.md`.

## The app

Five tabs: 对话 (chat), 任务 (tasks and recent runs), 文档 (documents), 想法 (ideas) and 设置 (settings). `AppModel` (`App/`) owns the credentials, the event stream, the `Timeline` and the owner's sends; views only read it through the SwiftUI environment. The task, document and idea catalogs load their list and apply `*.updated` events; an item takes the version with the newest `updatedAt`, so a list read before an event cannot undo it.

- **Chat.** A pending message is dimmed until its echo arrives, and a failed send is retried with the same `clientId`. The chat has no stop button: sending `/stop` as a message stops the chat's run. A scheduled task's run is not the chat's, so its draft and steps stay out and a banner above the composer shows it. A file chip opens the document at the version the message delivered (`FileRef.documentId` and `.version`). Messages of the retired WeChat channel are tagged `微信`. The list follows new content only while it is at the bottom, or when the owner has just sent a message; scrolled up it stays where it is, and a button above the composer returns to the newest message.
- **Message text.** A bubble lays out the Markdown blocks of a message (`MessageMarkdown`) with SwiftUI `Text`, not `PassageText`, because nothing in the chat is annotated. Single line breaks are kept (`MarkdownDocument.blocks(from:keepsLineBreaks:)`), and only `http` and `https` links are links. A message that is more than one plain paragraph is one accessibility element carrying the bubble's identifier, and 复制 in the bubble's menu copies its text without the syntax.
- **Header.** `Chat/ChatHeader.swift` replaces the navigation bar with a bar as tall as the system's inline one, read from UIKit (`SystemBar.inlineHeight`); the avatar hangs below it, drawn by `ChatHeaderOverlay`. Its 更多 menu offers the slash commands (`Chat/ChatCommand.swift`) as items, and 取消配对.
- **Profile.** The avatar in the chat's header is a button, the only part of `ChatHeaderOverlay` that takes touches (a drag that starts on it no longer scrolls the list), and it pushes `Profile/ProfileView.swift` onto the chat's `NavigationStack`: the avatar at 128 pt over the name, then a segmented control with 规则 and 记忆, then the part's content; the avatar and the control are the first things in that content, in both parts (in the rules' `ScrollView`, in the first row of the memories' `List`). The control scrolls up with them until it reaches the bottom edge of the navigation bar; from there a second control in a `safeAreaBar` holds it, with the content scrolling under it with the system's soft edge (a bar hosts only what lies in its frame, so one control cannot be moved from under the avatar to the bar). 规则 shows the root `ALFRED.md` (`GET /api/rules`) as Markdown, with pull to refresh. 编辑 swaps it for a `TextEditor` holding a `RulesDraft`: the bar shows 取消 and 保存, the back button is gone, the segmented control is off and the avatar is not shown, so the editor has the room, and a bottom bar counts the UTF-8 bytes against the server's `maxBytes`, in red over it. 保存 sends `rules.save` against the version the draft started from; a 409 offers 载入新内容 (the draft becomes what the server holds) or 取消 (stay with the draft), and any other failure uses the usual alert and keeps the draft. 取消 on a changed text asks before dropping it.
- **Memory.** 记忆 lists Alfred's long-term memories (`GET /api/memories`, `MemoryCatalog`) in an inset-grouped `List` with a search (a button in the bar that opens the field: `searchToolbarBehavior(.minimize)`; it matches name, description and body), a section for each kind (关于你, 偏好, 项目, 纠正, and 其他 for any other string) in that order, and the server's order inside a section, which is most recently updated first. A memory beyond `promptCount`, the part of the list that is in Alfred's system prompt, says 不在提示中. A row opens the memory's page (kind, date, the body as Markdown) and its 编辑 pushes the form; ＋ opens the same form in a sheet for a new one. The form (`MemoryDraft`) checks the contract's limits (a name of 1 to 80 characters and a description of up to 200, each one line; a body of up to 8192 bytes), is left only through 取消 (which asks when something was typed) and sends `memory.create` or `memory.update` against the version the draft started from. A memory of a kind Alfred no longer writes is edited with its kind shown as 其他 and a kind of the four to choose before saving. A delete (swipe or context menu) asks first and leaves the list at once. There are no memory events, so the model applies the owner's own changes to the list and reads it again afterwards (the server's order, `promptCount`). Errors: a 409 whose message begins `version:` (the server's words for a stale version) or has none offers 重新载入 (the list is read again and an edit's draft becomes the memory as it is now); any other 409, which is Alfred tidying memory, shows its message and keeps the draft; a 404 closes the pages and reads the list again.
- **Tasks.** Schedules show in the owner's zone (`TaskList.timeZone`), not the phone's.
- **Ideas.** 采纳 opens the task form filled in from the idea (`TaskForm(accepting:)`); a one-off idea gets a 立即 kind that sends no schedule. 讨论 only puts the brief into the composer (`AppModel.composerText`). The badge counts open ideas not yet seen (`SeenIdeas` in `UserDefaults`); ideas never push. A line above the list explains a generation that added nothing, from `lastGeneration`.
- **Settings.** `SettingsCatalog` holds Alfred's settings and today's spend (`GET /api/settings`) and applies `settings.updated`. The settings carry no timestamp, so an event at or below the newest event id applied is ignored, and a read or a command's reply that began before an event does not replace what the event said. A change shows at once and is sent as one `settings.update`; one call is out at a time. Steppers send half a second after the last tap (`AppModel.adjustSettings`), so several taps make one command. A failed save puts the value back and says why in `actionFailure`. The notification row is the system's authorization state (`PushSystem.authorization()`), read again when the app returns to the foreground. 取消配对 is here too, behind a confirmation.
- **Annotating.** Selecting text in one block of the current version of a Markdown or text document offers `批注` in the edit menu; the text is a UIKit text view (`PassageText`) because SwiftUI `Text` does not expose the selection. `整篇批注` works on every kind; passages in HTML and PDF are not annotated yet (#120). A passage is the quote plus up to 32 scalars of prefix and suffix, which `AnchorText.locate` uses to re-anchor it on another version. Drafts live in `Application Support/Alfred/annotation-drafts.json`. 提交 sends up to 50 as one `document.revise`; a 409 reloads the document and keeps the drafts.
- **Viewer.** A file is downloaded (`GET /api/files/<path>`, `?version=` for a version) and shown by extension (`FileViewerKind`): Markdown, PDFKit, images, monospaced text (256 KB), HTML and SVG in the isolated web view, else QuickLook.
- **Report isolation.** HTML runs in a web view kept away from the app: a non-persistent data store, no script message handler, a content rule list that blocks every load except the document and `data:` URLs (a report whose list fails to compile is not shown), and a load from a string with a `nil` base URL whose navigation delegate cancels every navigation after it.
- **Avatar.** `working` while a chat run runs, `standingBy` otherwise. `AvatarDirector` (pure, with an injected random source and clock) picks the clip: idle clips after 8 to 20 seconds, or `work-start`, `work-loop`, `work-end`. The clips are H.264 files without audio in `Alfred/Avatar/Clips/` (`xcodegen` bundles whatever is there), with `still.png` and `typing.png` for the two poses. `AvatarPlayer` never shows a video layer that has not drawn: an opaque cover with the picture of the pose the clip starts on stays up until the lane has drawn.

## Pairing

One QR code carries the server URL, the Cloudflare Access service token and the device token. Scan it (VisionKit, where there is a camera) or paste the pairing JSON with `粘贴配对信息`, the way in on the simulator and in UI tests; the whole `[pairing] {…}` line `app-dev` prints works. The app checks it with `GET /api/ping` and only then saves it. `取消配对` in the chat menu or in 设置 deletes it.

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

- **Plain `app-dev`:** `ChatUITests`, `RunsUITests`, `QuestionsUITests`, `TasksUITests`, `ChatHeaderUITests`, `ProfileUITests`, `PushUITests`, `SettingsUITests`, `ShareUITests`. Most run the model on haiku, a fraction of a cent per test; `ChatHeaderUITests`, `ProfileUITests`, `PushUITests` and `SettingsUITests` run none (`/status` and `/model` are answered by Alfred itself). `ProfileUITests` replaces the workspace's `ALFRED.md` with text of its own and leaves it so, and its conflict test saves a second version through the workbench API with the pairing's device token. `SettingsUITests` changes the stack's model and leaves it on haiku.
- **`--seed-documents`:** `DocumentsUITests` (no model) and `AnnotationsUITests` (its second test runs the model, a few cents).
- **`--seed-memories`:** `MemoryUITests` (no model). It changes the memories (renames one, adds one, deletes one), so each run needs a new `ALFRED_STATE_DIR` and `ALFRED_WORKSPACE`; its tests run in name order, and the last three change memories behind the app's back through the workbench API, as `ProfileUITests`' conflict test does (the last adds memories, so that the list has to scroll).
- **`--seed-ideas`:** `IdeasUITests` runs no model but uses up the seeded ideas, so each run needs a new `ALFRED_STATE_DIR` and `ALFRED_WORKSPACE`; its tests run in name order.
- **`TEST_RUNNER_ALFRED_SHOTS`**, a directory, makes `ChatHeaderUITests`, `ProfileUITests`, `MemoryUITests`, `AnnotationsUITests` and `IdeasUITests` save screenshots there. `ProfileUITests` and `MemoryUITests` save them in the appearance the simulator has (`xcrun simctl ui <udid> appearance dark` for the dark ones).
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
