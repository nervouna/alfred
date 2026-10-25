# iOS client

`AlfredKit/` is a Swift package with the client's Codable model of Alfred's API: events, commands and the objects they carry. Its tests decode the shared JSON fixtures in `fixtures/api/`.

`Alfred/` is the app, and `AlfredShare/` is its Share Extension. `Config/` holds the build settings. `project.yml` is the XcodeGen spec for the Xcode project; the `.xcodeproj` is generated and not committed.

Build tools: Xcode 27 and XcodeGen (`brew install xcodegen`).

## The app

The 对话 tab is the chat with Alfred; 运行 and 文档 are placeholders.

- `App/` holds `AppModel`, which owns the credentials, the event stream and the `Timeline` it builds, and the owner's sends. The views only read it.
- `Pairing/` is the first screen, shown while the app has no credentials.
- `Chat/` is the conversation: messages in timeline order (WeChat ones tagged `微信`, failed WeChat sends `微信未送达`), the owner's pending messages dimmed until their echo arrives (a failed send says `发送失败，点按重试` and a tap sends it again with the same `clientId`), each run's draft reply with its latest step under it, the composer, a stop button while a task runs, and a menu with `取消配对`.

### Pairing

One QR code carries the server URL, the Cloudflare Access service token and the device token. The app pairs in one of two ways:

- **Scan the QR code.** The scanner (VisionKit's `DataScannerViewController`) is offered where the device has a camera and the camera is allowed. The simulator has none.
- **Paste the pairing.** Copy the pairing JSON, then tap the paste button (`粘贴配对信息`). It needs no paste prompt, and it is the way in on the simulator and in UI tests. The JSON may come after other text, so the whole `[pairing] {…}` line `app-dev` prints can be pasted.

The app decodes the pairing, checks it with `GET /api/ping`, and only then saves it to the keychain. A failure stays on the screen with its reason: not a valid pairing, the device was refused (401), Access refused (403), or a network error.

The credentials live in one keychain item, in the access group from the `AlfredKeychainAccessGroup` Info.plist value (`$(AppIdentifierPrefix)$(ALFRED_BUNDLE_ID)`), which the Share Extension shares. A simulator build has no group, so the app uses its default one. The simulator's keychain refuses an app that is not signed (status -34018): build the simulator app with the default signing, as the test commands below do, and not with `CODE_SIGNING_ALLOWED=NO`, which is only good for checking that it compiles.

If the server stops accepting the device, the app says so and offers `重新配对`, which deletes the credentials. If Cloudflare Access refuses the stream, it offers a retry. `取消配对` in the chat's menu deletes the credentials too, after a confirmation.

### The event stream

The app follows `/api/events` from the `Timeline`'s last event id while its scene is active. A scene that goes to the background drops the stream; when it is active again, the stream starts from the same id, so what happened meanwhile arrives then. A banner says `连接中…` until the stream is connected.

## Build for the simulator

```bash
xcodegen generate --spec ios/project.yml
xcodebuild -project ios/Alfred.xcodeproj -scheme Alfred -destination 'generic/platform=iOS Simulator' -derivedDataPath ios/build CODE_SIGNING_ALLOWED=NO build
```

## Run against a local Alfred

`node scripts/app-dev.ts` (from the repository root) runs Alfred for the simulator: the real handler without WeChat, behind the command API, and the workbench on `http://127.0.0.1:8787` with no TLS. Point `ALFRED_STATE_DIR` and `ALFRED_WORKSPACE` at new scratch directories and set `ALFRED_ANTHROPIC_API_KEY`. Keep the state directory path short: the command API's Unix socket path has to fit in about 104 bytes, so use something like `mktemp -d /tmp/a.XXXX`. It prints the pairing as one `[pairing]` line: paste its JSON into the app. A later start says the simulator is already paired; `--repair` pairs a new device. Messages other than commands run the model (haiku, about a tenth of a cent each); `/status` costs nothing.

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

- `AlfredTests` are unit tests of `AppModel` on a stubbed `URLSession`: pairing, unpairing, sending and retrying, the stream's restart and its errors.

  ```bash
  xcodegen generate --spec ios/project.yml
  xcodebuild test -project ios/Alfred.xcodeproj -scheme Alfred -destination 'id=<udid>' -derivedDataPath ios/build -only-testing:AlfredTests -collect-test-diagnostics never
  ```

- `AlfredUITests` drive the app against a running `app-dev`. Start `app-dev` as above, copy the JSON of its `[pairing]` line, and pass it as `TEST_RUNNER_ALFRED_PAIRING` (xcodebuild hands it to the test as `ALFRED_PAIRING`). The test puts the pairing on the pasteboard and taps the paste button, sends `/status` and a message the model answers, then goes to the home screen, sends a message from outside the app, and checks that it shows once the app is back. It costs about a tenth of a cent. Stop `app-dev` afterwards (SIGTERM, or Ctrl-C).

  ```bash
  TEST_RUNNER_ALFRED_PAIRING='{"version":1,…}' xcodebuild test -project ios/Alfred.xcodeproj -scheme Alfred -destination 'id=<udid>' -derivedDataPath ios/build -only-testing:AlfredUITests -collect-test-diagnostics never
  ```

  Without `ALFRED_PAIRING` the test skips itself, so a plain test run needs no stack. The test starts from the pairing screen whatever the app was left in, so it can run again against the same stack or a new one.

## Continuous integration

The `app` job in `.github/workflows/ios.yml` builds the simulator target on `macos-26`. No runner has Xcode 27 yet, so the job selects the newest installed Xcode and passes `IPHONEOS_DEPLOYMENT_TARGET` on the `xcodebuild` command line, set to that SDK's major version (26.0 for the Xcode 26 SDK). `project.yml` and local or device builds stay at iOS 27.0. Remove the override from the workflow once a runner has Xcode 27. CI only builds; it does not run the app's tests.
