# iOS client

`README.md` here is the reference (build, run, test, CI). Lessons from working on the app:

## Test

- CI builds the app but does not run its unit or UI tests (`README.md`, Test). After an app change to a screen other tests pass through, run the whole `AlfredUITests` suite, each group against the stack it needs (`README.md`, Test): plain `app-dev`, `--seed-documents`, and a fresh `--seed-ideas` for `IdeasUITests` and a fresh `--seed-memories` for `MemoryUITests`.
- If another `app-dev` holds port 8787, start yours with `--port <n>`; the pairing it prints carries the port.
- Run UI tests on a simulator that holds only the test build (`com.example.alfred`): a second Alfred build there adds a second share extension, and `ShareUITests` picks the wrong one. The share tests can fail on a new simulator's first run; rerun before blaming a change.
- Add `ShareUITests`' photo before the run, not during it (`xcrun simctl addmedia <udid> ios/Alfred/Avatar/Clips/still.png`): an `addmedia` during a run stalled the simulator and hung the suite.
- `ChatUITests.testPairThenChat` can fail with no `/status` reply when it is the first test against a fresh `app-dev`; it passes on a rerun, so rerun before blaming a change.
- After `simctl install` of a differently built app, the notification prompt can block the chat until it is answered; pair through a short UI test (for example `ChatHeaderUITests/testTheMenuStillOffersUnpairing`), which answers it, before taking screenshots with `xcrun simctl io <udid> screenshot`.
- XCUITest calls a control hittable while it sits under the keyboard or in a sheet that is still resizing: tap once its frame holds still, as `tapWhenSettled` in `IdeasUITests` does. The other way round, the chat's avatar (a button over the list) can be reported not hittable while a tap on it works: tap it once its frame holds still, and let the page it opens be the check (`ProfileUITests`).
- A `confirmationDialog` that a toolbar button opens is a popover with no cancel button: tap the `PopoverDismissRegion` element to dismiss it without choosing.
- `XCUIKeyboardKey.forwardDelete` is typed as a character (U+F728) in a text view; only `.delete` works, so clear a text view by deleting back from the end of its text, where a view that has just taken focus puts the caret.
- A row under the glass navigation bar or tab bar also counts as hittable, but the tap lands on the bar: scroll it between the bars first (`scrollBetweenBars` in `TasksUITests` and `IdeasUITests`).
- Run `xcodegen generate` again after adding a source or test file: a stale project builds, runs 0 tests of the new file and exits 0. Read the executed and skipped counts of every group.
- A build or test run cut short (`BUILD INTERRUPTED`, exit 143) while another session's `xcodebuild` is running is not a failure of the change: check `ps -axo pid,etime,command | grep xcodebuild`, leave the other one alone, and rerun on a simulator of your own.
- Keep the simulator's hardware keyboard off: with it connected, an off-screen `Keyboard` element stays in the tree and `RunsUITests` and `PushUITests` fail on `the keyboard stayed up`.
- `ChatHeaderUITests.testTheFirstMessageIsNotCoveredByTheAvatar` swipes back to the start of the history and gives up after 120 s: run it against a stack with a short history (it sorts first in the plain group).
- To capture a state the app has to be driven into (scrolled up, keyboard open), add a temporary UI test that drives there and waits, take `xcrun simctl io <udid> screenshot` meanwhile, and do not commit the test: driving the simulator by hand needs the owner to grant access, which fails while they are away.

## Look and feel

- Check bar and edge-effect changes in the dark appearance (`xcrun simctl ui <udid> appearance dark`): the soft edge fade is invisible on white, and `XCUIDevice.shared.appearance` did not switch it in a UI test.
- A `safeAreaBar`'s scroll edge effect covers everything the bar draws, overflow included: draw content that hangs below a bar (the chat's avatar) as an overlay of the screen, not inside the bar.
- Judge flicker frame by frame, not by eye: record with `xcrun simctl io <udid> recordVideo --codec=h264 <file>` (stop it with SIGINT) and compare frames. An `AVPlayerLayer` with no frame draws nothing on the simulator but black on a phone, so layer transitions need a check on the phone.
- The profile page is pushed with `navigationDestination(isPresented:)`, so a `NavigationLink(value:)` inside it (typed destination) rebuilt the page and sent it back to 规则: link with a destination closure (`NavigationLink { … } label: { … }`), and push forms with `navigationDestination(item:)`.
- `.searchable` on the memory list left its field hidden above the first row and scrolled the avatar under the pinned control; `.searchToolbarBehavior(.minimize)` (a Search button in the bar) does not move the content.
- The memory list asks before a delete in an `.alert` on the `List` (its buttons are in `app.alerts`). Not on the row: a dialog hung on a list row is lost when the swipe action that opens it takes the row away, also when the list holds the state that opens it (#215: `deleting` in the list, `isPresented` true for the row's memory, and the dialog never opened).
- A `safeAreaBar` hosts only what lies in its frame: a control moved out of a bar with `offset` (the bar given no room, so the control hung below it) was drawn, but a tap on it did nothing. A control that has to scroll with the content and then pin has two instances: one in the content and one in the bar, shown once the content has scrolled up to the bar (`ProfileView`). The bar's room is part of the scroll view's top inset (`ScrollGeometry.contentInsets`) while it shows, so a scroll offset counted from the inset moves by the bar's height when it appears.
- A drag in a UI test loses its first points to the touch slop and carries on after the finger lifts: drag slowly and hold at the end (`press(forDuration:thenDragTo:withVelocity: .slow, thenHoldForDuration:)`), and look at the frames again to drag the rest (`drag(_:to:in:)` in `ProfileUITests`).
- A hero half under the glass navigation bar still counts as hittable: for the top of a list, test that the avatar's frame lies below the navigation bar, by the hero's own padding (`scrollToTop` in `MemoryUITests`).
- A control that sits in a scroll view's content and in a list's first row lands a third of a point apart in the two: compare its place across the parts with a tolerance of one point (`samePlace` in `ProfileUITests`). The list's first section needs `listSectionMargins([.top, .horizontal], 0)` to start at the top and span the width as the scroll view's content does.
- `.buttonStyle(.glass)` pads its label by 7 pt on every side, so a 44 pt circle takes a 30 pt label.
- `defaultScrollAnchor(.bottom)` leaves a scrolled-up list where it is as content grows, but it does not keep the end in view when the container shrinks (the keyboard): a list that should stay at the end scrolls there itself on a container change (`MessageList`).
- `onChange` of a value derived from the model sees only what is there when the view draws: two model changes between draws (a pending message and its echo) can look like none. Watch the model with `Observations` when every change counts.

## On the phone

- To time something on the real path, put temporary `print`s in a Release build (never commit them), install it, and run `xcrun devicectl device process launch --console --terminate-existing --device <name> io.damao.alfred`. A warm start is launching `com.apple.Preferences`, waiting, then launching Alfred again without `--terminate-existing`.
- `devicectl` reporting the phone `unavailable` (CoreDevice error 4016 on install) means it is locked or off the network: ask the owner to unlock it, and keep the built `.app` so the install does not wait for another build.
- Build the phone install from `origin/main` in a throwaway `git worktree add --detach <dir> origin/main`, not from whatever branch the checkout is on, and copy `ios/Config/Signing.xcconfig` into it first (git ignores it, so a worktree has none). Remove the worktree afterwards.
- Before a phone install, compare the deployed commit (`git -C alfred log -1` on the host) with `git log <deployed>..origin/main -- src`, and deploy first if the server changed: an app newer than the server can show an empty chat, as one waiting for the `caught-up` frame (#201) did.
