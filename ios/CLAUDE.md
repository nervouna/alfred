# iOS client

`README.md` here is the reference (build, run, test, CI). Lessons from working on the app:

## Test

- CI builds the app but does not run its unit or UI tests (`README.md`, Test). After an app change to a screen other tests pass through, run the whole `AlfredUITests` suite against `node scripts/app-dev.ts --seed-documents`.
- If another `app-dev` holds port 8787, start yours with `--port <n>`; the pairing it prints carries the port.
- Run UI tests on a simulator that holds only the test build (`com.example.alfred`): a second Alfred build there adds a second share extension, and `ShareUITests` picks the wrong one. The share tests can fail on a new simulator's first run; rerun before blaming a change.
- `ChatUITests.testPairThenChat` can fail with no `/status` reply when it is the first test against a fresh `app-dev`; it passes on a rerun, so rerun before blaming a change.
- After `simctl install` of a differently built app, the notification prompt can block the chat until it is answered; pair through a short UI test (for example `ChatHeaderUITests/testTheMenuStillOffersUnpairing`), which answers it, before taking screenshots with `xcrun simctl io <udid> screenshot`.
- XCUITest calls a control hittable while it sits under the keyboard or in a sheet that is still resizing: tap once its frame holds still, as `tapWhenSettled` in `IdeasUITests` does.
- A row under the glass navigation bar or tab bar also counts as hittable, but the tap lands on the bar: scroll it between the bars first (`scrollBetweenBars` in `TasksUITests` and `IdeasUITests`).

## Look and feel

- Check bar and edge-effect changes in the dark appearance (`xcrun simctl ui <udid> appearance dark`): the soft edge fade is invisible on white, and `XCUIDevice.shared.appearance` did not switch it in a UI test.
- A `safeAreaBar`'s scroll edge effect covers everything the bar draws, overflow included: draw content that hangs below a bar (the chat's avatar) as an overlay of the screen, not inside the bar.
- Judge flicker frame by frame, not by eye: record with `xcrun simctl io <udid> recordVideo --codec=h264 <file>` (stop it with SIGINT) and compare frames. An `AVPlayerLayer` with no frame draws nothing on the simulator but black on a phone, so layer transitions need a check on the phone.

## On the phone

- To time something on the real path, put temporary `print`s in a Release build (never commit them), install it, and run `xcrun devicectl device process launch --console --terminate-existing --device <name> io.damao.alfred`. A warm start is launching `com.apple.Preferences`, waiting, then launching Alfred again without `--terminate-existing`.
- `devicectl` reporting the phone `unavailable` (CoreDevice error 4016 on install) means it is locked or off the network: ask the owner to unlock it, and keep the built `.app` so the install does not wait for another build.
