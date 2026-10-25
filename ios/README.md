# iOS client

`AlfredKit/` is a Swift package with the client's Codable model of Alfred's API: events, commands and the objects they carry. Its tests decode the shared JSON fixtures in `fixtures/api/`.

`Alfred/` is the app, with three placeholder tabs, and `AlfredShare/` is its Share Extension. `Config/` holds the build settings. `project.yml` is the XcodeGen spec for the Xcode project; the `.xcodeproj` is generated and not committed.

Build tools: Xcode 27 and XcodeGen (`brew install xcodegen`).

## Build for the simulator

```bash
xcodegen generate --spec ios/project.yml
xcodebuild -project ios/Alfred.xcodeproj -scheme Alfred -destination 'generic/platform=iOS Simulator' -derivedDataPath ios/build CODE_SIGNING_ALLOWED=NO build
```

## Run against a local Alfred

`node scripts/app-dev.ts` (from the repository root) runs Alfred for the simulator: the real handler without WeChat, behind the command API, and the workbench on `http://127.0.0.1:8787` with no TLS. Point `ALFRED_STATE_DIR` and `ALFRED_WORKSPACE` at new scratch directories and set `ALFRED_ANTHROPIC_API_KEY`. It prints the pairing as one `[pairing]` line: paste its JSON into the app. A later start says the simulator is already paired; `--repair` pairs a new device.

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

## Continuous integration

The `app` job in `.github/workflows/ios.yml` builds the simulator target on `macos-26`. No runner has Xcode 27 yet, so the job selects the newest installed Xcode and passes `IPHONEOS_DEPLOYMENT_TARGET` on the `xcodebuild` command line, set to that SDK's major version (26.0 for the Xcode 26 SDK). `project.yml` and local or device builds stay at iOS 27.0. Remove the override from the workflow once a runner has Xcode 27.
