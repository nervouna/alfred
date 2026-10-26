# iOS client

`AlfredKit/` is a Swift package with the client's Codable model of Alfred's API: events, commands and the objects they carry. Its tests decode the shared JSON fixtures in `fixtures/api/`.

`Alfred/` is the app, and `AlfredShare/` is its Share Extension. `Shared/` holds the code both compile: the keychain store, the 50 MiB limit, the HEIC-to-JPEG conversion, and the share logic (what the extension reads, `ShareModel`), which lives there so the app's unit tests can reach it. `Config/` holds the build settings. `project.yml` is the XcodeGen spec for the Xcode project; the `.xcodeproj` is generated and not committed.

Build tools: Xcode 27 and XcodeGen (`brew install xcodegen`).

## The app

The 对话 tab is the chat with Alfred, 任务 lists the owner's tasks and Alfred's recent runs, and 文档 lists the files it delivered or wrote. Any file opens in the viewer.

- `App/` holds `AppModel`, which owns the credentials, the event stream and the `Timeline` it builds, and the owner's sends. The views only read it, and reach it through the SwiftUI environment (`RootView` puts it there).
- `Pairing/` is the first screen, shown while the app has no credentials.
- `Chat/` is the conversation: messages in timeline order (messages from the retired WeChat channel, still in the event log, tagged `微信`, and its failed sends `微信未送达`) with Alfred's questions as cards where they were asked, the owner's pending messages dimmed until their echo arrives (a failed send says `发送失败，点按重试` and a tap sends it again with the same `clientId`), each chat run's draft reply with its latest step under it, the composer with its attach button, a stop button while a chat run runs (it stops that run only), and a menu with `取消配对`. A file chip under a message opens its file in the viewer. A message that a task's run delivered carries the task's title as a small label above its bubble, when the app knows the task (see Tasks below). A scheduled task's run is not the chat's: its draft and steps stay out of the chat, and the stop button does not stop it. While one runs, a row above the composer (`taskRunBanner`) says `定时任务「<title>」运行中`, with the run's latest step under it when there is one. The title is the task's when the app knows the task, else the run's. One row per run, oldest first; a tap opens the run's detail, the same view as in 任务, with its own `停止`.
- `Tasks/` is the 任务 tab, described under Tasks below. Below the tasks it lists the recent runs: the list is fetched (`GET /api/runs`) when the tab appears and on pull to refresh, newest first; a run the stream knows takes its latest version from the `Timeline`, so a running run updates live, and a run only the stream has told of is listed too.
- `Runs/` holds what shows a run, in that list and in a task's runs. A row shows the title, the status (排队中, 进行中, 完成, 已停止, 失败, 中断), `子任务` for a subagent, the short model name, the cost (`$0.003` under a dollar, `$1.25` from a dollar up) and the start time. A run's detail (`GET /api/runs/<id>`) shows its steps, the files it wrote, its error, a link to the parent run for a subagent, and a `停止` button while it is running, which sends `run.stop`.
- `Documents/` is the 文档 tab and the viewer. The list holds the files of Alfred's outbound messages and of the runs the tab has loaded or the stream has told of, once per path, newest first; a run's files are dated by when the run ended (or started, while it runs).
- `Push/` is the notifications: the app delegate, what the app asks the system for, the token and the payload. See Push below.
- `AppIcon.icon` is the app icon, an Icon Composer document with two image layers and the system glass off: the dinner suit and bow tie, cut out, over an oxblood plate. The dark appearance swaps in a darker plate; the clear and tinted appearances hide the plate and let the system tint the suit.

### Tasks

The 任务 tab lists the owner's tasks above the recent runs (`Tasks/`). A task is a brief Alfred runs on a schedule; the app creates, changes and runs tasks with the task commands, and `AppModel` keeps them (`TaskCatalog`).

- **The list.** Active and paused tasks come first, newest created first, a paused one marked `已暂停`; tasks that have ended are under a collapsed `已结束`. A row shows the title, the schedule in words and the next run as a relative time. With no tasks the tab shows only the runs. The `+` button opens the form.
- **Schedules in words.** `每天 08:00`, `每周一、三、五 08:00` (`每个工作日 08:00` for Monday to Friday, `每天 08:00` for all seven days), `每 6 小时` and `10月28日 09:00 一次`. A time of day and the weekdays are in the owner's zone (`TaskList.timeZone`, not the phone's); when the phone's clock reads differently (another UTC offset), they say whose time it is: `每天 08:00（台北时间）`. A one-time run is an instant and shows on the phone's clock.
- **Kept current.** `AppModel` reads `GET /api/tasks` when the stream connects (and again each time it reconnects), when the tab appears and on pull to refresh, and applies every `task.updated` event. A task takes its latest version by `updatedAt`, so a list read before an event cannot undo it, and tasks are never removed. A task that ends moves to `已结束`.
- **The detail** (`GET /api/tasks/<id>`) shows the brief in full, the schedule in words, the next run (date and relative), the model, the per-run cap, the origin (`手动`, `对话`, `想法`), the skips with their time and reason (`错过（Alfred 当时未运行）`, `已达每日上限`) and the task's runs, each opening the run's detail. The task follows `task.updated` and its runs follow `run.updated`. The actions: `编辑`, `暂停` for an active task or `恢复` for a paused or an ended one (which makes it active again), `立即运行` (`已排队` shows until the run appears among the runs) and `结束`, which asks first. A refusal from the server shows as its own message.
- **The form** creates a task and edits one: title, brief, 每天 / 每周 / 每隔 / 一次 with a time picker (on the owner's clock), weekday toggles, an hours stepper from 1 to 168 or a date-and-time picker, the model (sonnet by default) and the per-run cap in USD (2 by default, at most 20). It checks what the contract checks before it sends: a blank title or brief, no weekday, a one-time run in the past (only when the schedule is new or changed), a cap outside 0 to 20. Creating sends the form's fields; editing sends only the fields that changed, and nothing when none did. A 400 shows its message at the top of the form and keeps what was typed.

### The viewer

A file is downloaded (`GET /api/files/<path>`, to a temporary file that goes with the screen) and shown by the extension of its name:

| Extension | Viewer |
|---|---|
| `md`, `markdown` | Markdown, block by block |
| `pdf` | PDFKit |
| `png`, `jpg`, `jpeg`, `gif`, `webp`, `heic` | the image, zoomable |
| `txt`, `json`, `jsonl`, `csv`, `tsv`, `log`, `yaml`, `yml`, `xml`, `js`, `ts`, `py`, `sh`, `css` | monospaced text (the first 256 KB) |
| `html`, `htm`, `svg` | the isolated web view |
| anything else | QuickLook |

Every viewer has a share button for the downloaded file. A failed download shows its reason and a retry.

Markdown is read with `AttributedString(markdown:)` and its full syntax. Each run of text says which blocks it is in (its presentation intent), and consecutive runs of the same innermost block become one block: headings, paragraphs, list items (with their bullet or number and nesting), block quotes, code blocks, thematic breaks and tables. Images show as their alt text, nothing loads, and only a web link opens, in the system browser.

An HTML report runs in a web view that is kept away from the app, as the workbench's `REPORT_CSP` does for the web: its own script and style run so charts draw, and nothing loads from anywhere.

- The web view uses a non-persistent website data store and has no script message handler, so the page cannot call into the app, and the app's tokens (the keychain and `AlfredClient`) are out of its reach.
- A content rule list blocks every load but the document itself and `data:` URLs. The web view does not load until the list is compiled, and a report whose list cannot be compiled is not shown.
- The report loads from a string with a `nil` base URL. The navigation delegate allows that one load and cancels every navigation after it, so a tapped link, a form or a script that sets the location opens nothing, and link previews are off.

### Pairing

One QR code carries the server URL, the Cloudflare Access service token and the device token. The app pairs in one of two ways:

- **Scan the QR code.** The scanner (VisionKit's `DataScannerViewController`) is offered where the device has a camera and the camera is allowed. The simulator has none.
- **Paste the pairing.** Copy the pairing JSON, then tap the paste button (`粘贴配对信息`). It needs no paste prompt, and it is the way in on the simulator and in UI tests. The JSON may come after other text, so the whole `[pairing] {…}` line `app-dev` prints can be pasted.

The app decodes the pairing, checks it with `GET /api/ping`, and only then saves it to the keychain. A failure stays on the screen with its reason: not a valid pairing, the device was refused (401), Access refused (403), or a network error.

The credentials live in one keychain item (service `alfred`), in the access group from the `AlfredKeychainAccessGroup` Info.plist value (`$(AppIdentifierPrefix)$(ALFRED_BUNDLE_ID)`). The Share Extension has the same key in its own Info.plist and the same group in its entitlements, and reads the item through `AppKeychain` too. A simulator build has no group, so both use their default one; signed the same way, they get the same default, and the extension reads the pairing in the simulator as well (`ShareUITests` relies on it). The simulator's keychain refuses an app that is not signed (status -34018): build the simulator app with the default signing, as the test commands below do, and not with `CODE_SIGNING_ALLOWED=NO`, which is only good for checking that it compiles.

If the server stops accepting the device, the app says so and offers `重新配对`, which deletes the credentials. If Cloudflare Access refuses the stream, it offers a retry. `取消配对` in the chat's menu deletes the credentials too, after a confirmation.

### The event stream

The app follows `/api/events` from the `Timeline`'s last event id while its scene is active. A scene that goes to the background drops the stream; when it is active again, the stream starts from the same id, so what happened meanwhile arrives then. A banner says `连接中…` until the stream is connected. Each time it connects the app also reads the task list again.

### Attachments

The `+` button in the composer offers 照片 (the system photo picker, several at once) and 文件 (the file picker, any type). A chosen item is copied into the app's temporary `attachments/` area and shows as a removable chip above the field; the copy goes when the chip is removed, when the message's echo arrives, or when the app unpairs.

- **Limits.** At most 10 files, each at most 50 MiB (Alfred's own limits). A file over the limit, or one past the tenth, is refused with its name in an alert; the others are still added. A file over the limit is refused before it is copied.
- **Photos.** Claude reads JPEG, PNG, GIF and WebP, not HEIC. A photo in any other format (HEIC, HEIF, TIFF, RAW) is written as a JPEG with ImageIO (quality 0.9, orientation and metadata kept) and uploaded as `<name>.jpg`; a photo already in one of the four formats goes up as it is. A file picked with 文件 is never converted.
- **Sending.** The message shows as pending at once, with a chip per file. The files are uploaded one after the other in the order they were chosen (`POST /api/uploads`, streamed from the staged copy), each chip showing its progress; when every file is saved, `message.send` goes out with their `FileRef`s and the text, which may be empty. A file that fails to upload is marked `上传失败` and the others still go up, but the message is not sent; the pending message says `发送失败，点按重试`, and the retry uploads only the files that failed (a file already saved is not uploaded again) before it sends, with the same `clientId`.

### Questions

A `question.asked` event shows as a card where it was asked, in event order among the messages: each question's header and text, and its options with their descriptions. `Timeline` keeps every question with its state and its position (how many messages came before it), so the card stays where it was asked.

- **Answering.** With one question that is not multi-select, tapping an option sends `question.answer` at once. Otherwise the options toggle and `提交` sends all the answers, with the labels of a multi-select question joined by `, `. Typing in the composer answers an open question too, but that is the server's rule and the card says nothing about it. A failed answer shows an error on the card and leaves the question open.
- **Afterwards.** An answered question shows its answers. A question cancelled by a stop shows `已取消`. A question whose run ended (`done`, `stopped`, `failed` or `lost`) without an answer shows `已结束`: the `Timeline` closes it on that `run.updated`.

### Push

The workbench pushes through APNs for Alfred's outbound messages on the app channel, and for questions (`src/workbench/push.ts`). The payload is `aps.alert` (title `Alfred` and the text), `sound: default` and `thread-id: chat`, plus the custom keys `eventId` and, when there is one, `runId`.

- **Permission and token.** After a successful pairing, and at each launch while paired, the app asks the system for permission to show alerts, play sounds and badge the icon (the system asks the owner once), and registers for remote notifications. The token goes to `POST /api/push` as lowercase hex, with the environment from the Info.plist key `AlfredAPNsEnvironment`, which `project.yml` sets to `development`: the owner installs a Release build signed with a development profile, whose `aps-environment` entitlement (`Alfred.entitlements`) is `development`. A build without the key registers nothing.
- **Registering again.** A token Alfred accepted is not sent again until it changes or the app pairs again. A 401 or 403 is the pairing and access-error flow's to show; any other failure leaves the token unregistered, and the next launch sends it again.
- **In the foreground.** With the chat tab on screen (the app active, paired and without an access error) a notification is not shown, because the chat already has the message. On the other tabs it shows as a banner with sound. In the background the system shows it.
- **A tap.** It opens the chat tab and scrolls to the message or question card that `eventId` names, when the timeline has it (`AppModel` keeps the event id of each); otherwise the chat just opens. The tap makes a new list, and a scroll made while it is still laying out its first rows can land on an estimate or be undone by the list's own start at the bottom, so the request stays until the row has been on screen at two checks in a row: the chat scrolls to it again every 100 ms, up to 40 times. New events do not move the list meanwhile, and follow the bottom again afterwards.
- **Unpairing** calls `unregisterForRemoteNotifications`. The server keeps the registration until the device is revoked: it has no call to remove one.

To see how the app handles a notification, push a payload shaped like the server's to the simulator while the app is in the background:

```bash
cat > payload.json <<'EOF'
{"aps":{"alert":{"title":"Alfred","body":"报告写好了"},"sound":"default","thread-id":"chat"},"eventId":42,"runId":"k7m2qa"}
EOF
xcrun simctl push <udid> com.example.alfred payload.json
```

The simulator asks for notification permission the first time the app pairs; allow it. `PushUITests` does this whole check (see Test).

### Share Extension

Share one web page, PDF or image from any app (the activation rule in `project.yml` lets exactly one through). A small sheet shows what is shared, a note field and `发送`. Without credentials it says `请先在 Alfred 里完成配对` and offers `关闭`. `ShareModel` (in `Shared/`) holds the logic, and `SharedContentLoader` reads what the host app handed over.

- **A page** is one `message.send`: the note, a blank line, then the page's title (when the host gave one, cut to 300 characters) and the address. Only `http` and `https` addresses are pages.
- **A PDF or an image** is copied by the file system into the extension's scratch area (never read into memory, because an extension has little of it) and uploaded from there with `upload(fileAt:)`; then a `message.send` names the file and carries the note, which may be empty. An image in a format Claude cannot read, HEIC among them, is written as a JPEG by ImageIO straight from the system's file. A file over 50 MiB is refused before it is copied. The file is named as the host app names it, with the extension of the copy.
- **Sending** shows progress. On success the request completes. On a failure the sheet shows the reason and `重试`: a file that was saved is not uploaded again, and the message keeps its client id, so one that did arrive is not stored twice.

## Build for the simulator

```bash
xcodegen generate --spec ios/project.yml
xcodebuild -project ios/Alfred.xcodeproj -scheme Alfred -destination 'generic/platform=iOS Simulator' -derivedDataPath ios/build CODE_SIGNING_ALLOWED=NO build
```

## Run against a local Alfred

`node scripts/app-dev.ts` (from the repository root) runs Alfred for the simulator: the real handler behind the command API, and the workbench on `http://127.0.0.1:8787` with no TLS. Point `ALFRED_STATE_DIR` and `ALFRED_WORKSPACE` at new scratch directories and set `ALFRED_ANTHROPIC_API_KEY`. Keep the state directory path short: the command API's Unix socket path has to fit in about 104 bytes, so use something like `mktemp -d /tmp/a.XXXX`. It prints the pairing as one `[pairing]` line: paste its JSON into the app. A later start says the simulator is already paired; `--repair` pairs a new device. Messages other than commands run the model (haiku, about a tenth of a cent each); `/status` costs nothing.

## Build for the phone

The owner's signing settings are not in the repo. Copy `Config/Signing.example.xcconfig` to `Config/Signing.xcconfig` (git ignores it) and fill in the team id and bundle id. `Base.xcconfig` includes that file, so the settings apply to every configuration.

```bash
xcodegen generate --spec ios/project.yml
xcodebuild -project ios/Alfred.xcodeproj -scheme Alfred -configuration Release -destination 'generic/platform=iOS' -derivedDataPath ios/build -allowProvisioningUpdates build
xcrun devicectl device install app --device <name> ios/build/Build/Products/Release-iphoneos/Alfred.app
```

The first install needs the developer trusted on the phone, under Settings > General > VPN & Device Management. Reinstall the app when its development profile expires.

## Test

Run the AlfredKit tests on macOS with Swift 6.0 or later: `swift test --package-path ios/AlfredKit`.

The app has two test targets in the `Alfred` scheme. Use a simulator of your own; `xcrun simctl create "alfred-test" com.apple.CoreSimulator.SimDeviceType.iPhone-18-Pro com.apple.CoreSimulator.SimRuntime.iOS-27-0` prints its id, and `xcrun simctl delete <id>` removes it. Build with the default signing (see Pairing), and add `-collect-test-diagnostics never` so a failed run does not wait on simulator diagnostics.

- `AlfredTests` are unit tests of `AppModel` on a stubbed `URLSession`: pairing, unpairing, sending and retrying, the stream's restart and its errors, attachments (the limits, the upload order, a failed upload and its retry, photos becoming JPEGs) and answering questions. They also cover the runs and documents lists, the tasks (the schedule in words with its zone note, the list's grouping and order, the form's checks and the fields it sends, `task.updated` events and the reload when the stream connects, the task commands, the chat label, the task run banner, and which run the stop button and the live replies take), the viewer chosen by extension, the Markdown blocks, and the isolation of the report web view (the navigation policy, the rules, and a real `WKWebView` loading a page). `PushTests` covers the token as lowercase hex, the registration body and its environment, registering again, the access errors, the permission calls, the foreground rule, reading `eventId` and `runId` from the payload, and what a tap opens. `ShareTests` covers the extension's logic: no credentials, a page with a title and a note as one `message.send`, a PDF as an upload and then a `message.send` with the file, a HEIC image converted to a JPEG, a failed send and its retry, and `SharedContentLoader` on real `NSItemProvider`s.

  ```bash
  xcodegen generate --spec ios/project.yml
  xcodebuild test -project ios/Alfred.xcodeproj -scheme Alfred -destination 'id=<udid>' -derivedDataPath ios/build -only-testing:AlfredTests -collect-test-diagnostics never
  ```

- `AlfredUITests` drive the app against a running `app-dev`. Start `app-dev` as above, copy the JSON of its `[pairing]` line, and pass it as `TEST_RUNNER_ALFRED_PAIRING` (xcodebuild hands it to the test as `ALFRED_PAIRING`). `ChatUITests` puts the pairing on the pasteboard and taps the paste button, sends `/status` and a message the model answers, then goes to the home screen, sends a message from outside the app, and checks that it shows once the app is back; it also checks that the attach button offers 照片 and 文件. `RunsUITests` has Alfred write `notes/hi.md`, follows the run through the 任务 tab (完成), its detail, the viewer and the 文档 tab, and opens a file chip in the chat. Each test that runs the model costs about a tenth of a cent. Stop `app-dev` afterwards (SIGTERM, or Ctrl-C).

  ```bash
  TEST_RUNNER_ALFRED_PAIRING='{"version":1,…}' xcodebuild test -project ios/Alfred.xcodeproj -scheme Alfred -destination 'id=<udid>' -derivedDataPath ios/build -only-testing:AlfredUITests -collect-test-diagnostics never
  ```

  `QuestionsUITests` asks the model to put a question (red or blue) with `AskUserQuestion`, then answers it three ways in three tests: it taps an option on the question card and checks that the card shows the answer and that a reply names the color; it types an answer in the composer; it stops the run and checks that the card says `已取消`. Each test costs a fraction of a cent. The system photo and file pickers are not driven by the UI tests.

  `TasksUITests` works the 任务 tab. One test creates a task in the form (daily, haiku, a cap of $0.30, a brief that asks for a two-line note and no web access), finds it in the list, opens its detail (brief, schedule, model and cap), pauses it (`已暂停` shows in the detail and the list) and resumes it, taps `立即运行` and waits for a run of the task to finish among the detail's runs, checks that the chat shows a message labelled with the task's title, ends the task behind its confirmation and finds it under `已结束`. It runs the model once, on haiku, for a fraction of a cent. The other test runs nothing: it saves a blank form and checks that the form names the problems and stays open, creates a task, edits only its cap and checks the detail, and ends the task. Tasks stay on the stack, so each test looks for the task it made by a title with a number in it.

  `PushUITests` checks notifications end to end. A test in the simulator cannot call `xcrun simctl push`, so a loop outside it does: the test writes `ready-<n>` into the directory named by `TEST_RUNNER_ALFRED_PUSH_DIR` whenever it wants a push, and the loop pushes the `payload.json` the test wrote there. The test sends `/status` eight times so the first reply is far above the screen, and writes a payload that names that reply. With the chat on screen it checks that no banner shows; on the 任务 tab it checks that one does; with the app in the background it taps the banner and checks that the chat tab is selected and the first reply is on screen, three times, each from the 任务 tab. It answers the system's notification question with Allow; on a new simulator the question can come late, so the test looks for it twice.

  ```bash
  # shell 1: the test
  mkdir -p /tmp/push-check && rm -f /tmp/push-check/*
  TEST_RUNNER_ALFRED_PUSH_DIR=/tmp/push-check TEST_RUNNER_ALFRED_PAIRING='{"version":1,…}' xcodebuild test -project ios/Alfred.xcodeproj -scheme Alfred -destination 'id=<udid>' -derivedDataPath ios/build -only-testing:AlfredUITests/PushUITests -collect-test-diagnostics never
  # shell 2: pushes whenever the test asks, until it is done
  n=1; until [ -e /tmp/push-check/done ]; do if [ -e /tmp/push-check/ready-$n ]; then xcrun simctl push <udid> com.example.alfred /tmp/push-check/payload.json; n=$((n+1)); fi; sleep 0.5; done
  ```

  `ShareUITests` shares the newest photo of the simulator's library from the Photos app to Alfred, with a note, and checks that the message and its file arrive in the chat; a second test leaves the app unpaired and checks that the sheet says `请先在 Alfred 里完成配对` and closes with `关闭`. Add a photo first (`xcrun simctl addmedia <udid> <image>`). The extension is found by its name in the share sheet; Photos' own controls are found by their identifiers, which may change with the system.

  Without `ALFRED_PAIRING` the tests skip themselves, so a plain test run needs no stack. Each test starts from the pairing screen whatever the app was left in, so they can run again against the same stack or a new one. Server replies are waited for 30 s and model replies 120 s.

## Continuous integration

The `app` job in `.github/workflows/ios.yml` builds the simulator target on `macos-26`. No runner has Xcode 27 yet, so the job selects the newest installed Xcode and passes `IPHONEOS_DEPLOYMENT_TARGET` on the `xcodebuild` command line, set to that SDK's major version (26.0 for the Xcode 26 SDK). `project.yml` and local or device builds stay at iOS 27.0. Remove the override from the workflow once a runner has Xcode 27. CI only builds; it does not run the app's tests.
