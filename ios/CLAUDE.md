# iOS client

`README.md` here is the reference (build, run, test, CI). Lessons for writing UI tests are in `AlfredUITests/CLAUDE.md`, for SwiftUI layout in `Alfred/CLAUDE.md`.

## Running tests

- CI runs none of the app's tests. While working, run `AlfredTests` and the `AlfredUITests` classes of the screens you change; run the whole suite once before the PR merges, each group against its stack (`README.md`, Test). A whole-suite run holds one of `simq`'s two slots for 30–54 minutes.
- Create one simulator per session and pass it to every `simq run`: a new simulator's first boot takes ~30 s (3–4 s after) and slows the machine for minutes. Keep only the test build (`com.example.alfred`) on it, or `ShareUITests` picks the other build's share extension, and keep its hardware keyboard off, or `RunsUITests` and `PushUITests` fail on `the keyboard stayed up`.
- Two runs at once need two simulators and two derived-data paths: two `xcodebuild` in one clash. A `cp -R` of the built one, used with `test-without-building`, is enough. A run cut short (`BUILD INTERRUPTED`, exit 143) while another session's `xcodebuild` runs is not your failure: leave that one alone and rerun on your own simulator.
- Known first-run flakes, rerun once on the same simulator before blaming a change: the share tests and `SettingsUITests.test1TheTabIsTheFifthAndShowsEveryRow` on a new simulator, `ChatUITests.testPairThenChat` as the first test against a fresh `app-dev`.
- A whole group failing at pairing (`pairing.error` 无法把配对信息存入钥匙串) is a test bundle built with `CODE_SIGNING_ALLOWED=NO`: build for testing with the default signing (`README.md`, Pairing).
- Run `xcodegen generate` after adding a file: a stale project runs 0 tests of it and exits 0. Read the executed and skipped counts of every group; `test-without-building` ends with `** TEST EXECUTE SUCCEEDED **`, not `** TEST SUCCEEDED **`.
- Add `ShareUITests`' photo before the run (`xcrun simctl addmedia <udid> ios/Alfred/Avatar/Clips/still.png`): an `addmedia` during it hung the suite.
- `ChatHeaderUITests.testTheFirstMessageIsNotCoveredByTheAvatar` gives up after 120 s of swiping back: run it against a short history (it sorts first in the plain group).
- If another `app-dev` holds port 8787, pass `--port <n>`.

## Screenshots

- After `simctl install` of a differently built app, the notification prompt blocks the chat: pair through a short UI test (`ChatHeaderUITests/testTheMenuStillOffersUnpairing`) before `xcrun simctl io <udid> screenshot`. The first keyboard shows a "Speed up your typing" tip that needs a tap on Continue.
- For a state the app has to be driven into, add a temporary UI test that drives there and waits, screenshot meanwhile, and do not commit it: driving the simulator by hand needs the owner's grant.
- Check bar and edge-effect changes in dark (`xcrun simctl ui <udid> appearance dark`; `XCUIDevice.shared.appearance` did not switch it). Judge flicker frame by frame: `xcrun simctl io <udid> recordVideo --codec=h264 <file>`, stopped with SIGINT.

## On the phone

- Build the install from `origin/main` in a throwaway `git worktree add --detach <dir> origin/main` with `ios/Config/Signing.xcconfig` copied in (git ignores it), and run `xcodegen generate` there (the project is not tracked); remove the worktree afterwards.
- Before installing, compare the deployed commit (`git -C alfred log -1` on the host) with `git log <deployed>..origin/main -- src`, and deploy first if the server changed: an app newer than the server can show an empty chat (#201).
- `devicectl` reporting the phone `unavailable` (error 4016) means locked or off the network: ask the owner to unlock it, and keep the built `.app`.
- To time the real path, put temporary `print`s in a Release build (never commit them) and run `xcrun devicectl device process launch --console --terminate-existing --device <name> io.damao.alfred`; for a warm start, launch `com.apple.Preferences`, wait, and launch Alfred without `--terminate-existing`.
- An `AVPlayerLayer` with no frame draws nothing on the simulator but black on a phone: check layer transitions on the phone.
