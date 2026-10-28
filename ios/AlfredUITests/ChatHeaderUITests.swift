import XCTest

/// Pairs the app with a running `scripts/app-dev.ts` and looks at the chat's header: a bar as tall as the system's inline
/// navigation bar with a round button on each side, and the avatar in the middle, outside the bar, with its lower third
/// below the bar's edge over the messages. It runs no model (`/status` is answered by Alfred itself). The pairing comes
/// from the environment variable `ALFRED_PAIRING` (pass `TEST_RUNNER_ALFRED_PAIRING` to xcodebuild); without it the tests
/// skip themselves.
///
/// When `ALFRED_SHOTS` names a directory (pass `TEST_RUNNER_ALFRED_SHOTS`), the list test saves screenshots of the chat
/// there, in the light and in the dark appearance.
///
/// Not tested here: that the bar keeps its height while `连接中…` shows. The test cannot make the stream disconnect (the
/// pairing needs the server up, the stream is `app-dev`'s, and the app connects within a few milliseconds), so the capsule
/// is only on screen for a moment at launch. `ChatHeaderTests` hosts the chat unconnected and connected and compares.
final class ChatHeaderUITests: XCTestCase {
    private let patience: TimeInterval = 30

    @MainActor
    func testTheHeaderHasItsButtonsAndTheAvatarHangsBelowTheBar() throws {
        let app = try launchPaired()
        let leading = element("chat.header.leading", in: app)
        let menu = element("chat.header.menu", in: app)
        let avatar = element("chat.header.avatar", in: app)
        XCTAssertTrue(leading.waitForExistence(timeout: patience), "no leading button\n\(app.debugDescription)")
        XCTAssertTrue(menu.exists, "no menu button\n\(app.debugDescription)")
        XCTAssertTrue(avatar.exists, "no avatar\n\(app.debugDescription)")
        XCTAssertEqual(leading.label, "占位")
        XCTAssertEqual(menu.label, "更多")

        // The buttons are 44 pt, the avatar 72 pt, centred between them.
        for button in [leading, menu] {
            XCTAssertEqual(button.frame.width, 44, accuracy: 1)
            XCTAssertEqual(button.frame.height, 44, accuracy: 1)
        }
        XCTAssertEqual(avatar.frame.width, 72, accuracy: 1)
        XCTAssertEqual(avatar.frame.height, 72, accuracy: 1)
        XCTAssertEqual(avatar.frame.midX, app.frame.midX, accuracy: 2)
        XCTAssertLessThan(leading.frame.maxX, avatar.frame.minX)
        XCTAssertGreaterThan(menu.frame.minX, avatar.frame.maxX)
        XCTAssertLessThan(leading.frame.midX, app.frame.midX)
        XCTAssertGreaterThan(menu.frame.midX, app.frame.midX)

        // The header sits below the status bar and the Dynamic Island, and the avatar reaches well below the buttons.
        XCTAssertGreaterThan(leading.frame.minY, 44, "the header is in the status bar")
        XCTAssertGreaterThan(avatar.frame.maxY, leading.frame.maxY + 16, "the avatar does not hang below the bar")

        // The leading button is a placeholder: it can be tapped and nothing happens.
        leading.tap()
        XCTAssertTrue(menu.exists && avatar.exists, "the header changed after a tap on the placeholder\n\(app.debugDescription)")
        XCTAssertEqual(app.sheets.count + app.alerts.count, 0, "the placeholder opened something\n\(app.debugDescription)")
    }

    /// The bar is as tall as the system's inline navigation bar, holds the two buttons, and the avatar's lower third, 24 pt
    /// of its 72, is below the bar's bottom edge.
    ///
    /// The system's inline bar is read from the 新建任务 sheet, whose bar has an inline title. The 任务 tab's own bar is not
    /// one: its title is a large title, which makes that bar taller while the list is at its start (a hosted
    /// `UINavigationBar` is 106 pt with a large title and 54 pt with an inline one on an iPhone 17 in iOS 27), so it is not
    /// a measure of the inline bar. Its height is in the failure message.
    @MainActor
    func testTheBarIsAsTallAsTheSystemsInlineBarAndTheAvatarHangsBelowIt() throws {
        let app = try launchPaired()
        let bar = element("chat.header.bar", in: app)
        let leading = element("chat.header.leading", in: app)
        let menu = element("chat.header.menu", in: app)
        let avatar = element("chat.header.avatar", in: app)
        XCTAssertTrue(bar.waitForExistence(timeout: patience), "no bar\n\(app.debugDescription)")
        XCTAssertTrue(avatar.waitForExistence(timeout: patience), "no avatar\n\(app.debugDescription)")
        let barFrame = bar.frame
        let avatarFrame = avatar.frame

        // The bar spans the screen, holds the two buttons, centred on it, and nothing else of the header.
        XCTAssertEqual(barFrame.width, app.frame.width, accuracy: 1, "the bar is not as wide as the screen")
        XCTAssertGreaterThan(barFrame.minY, 44, "the bar is in the status bar")
        for button in [leading, menu] {
            XCTAssertTrue(barFrame.insetBy(dx: -1, dy: -1).contains(button.frame), "a button is not inside the bar: \(button.frame) in \(barFrame)")
            XCTAssertEqual(button.frame.midY, barFrame.midY, accuracy: 1, "a button is not centred on the bar")
        }

        // The avatar is centred, 72 pt, its top inside the bar and its lower third (24 pt) below the bar's bottom edge.
        XCTAssertEqual(avatarFrame.height, 72, accuracy: 1)
        XCTAssertEqual(avatarFrame.maxY - barFrame.maxY, 24, accuracy: 2, "the avatar's lower third is not below the bar: avatar \(avatarFrame), bar \(barFrame)")
        XCTAssertEqual(barFrame.maxY - avatarFrame.minY, 48, accuracy: 2)

        // The bar is exactly as tall as the system's inline navigation bar, here the one of the new task form.
        app.tabBars.buttons["任务"].tap()
        let tasksBar = app.navigationBars.firstMatch
        XCTAssertTrue(tasksBar.waitForExistence(timeout: patience), "no navigation bar on the tasks tab\n\(app.debugDescription)")
        let tasksBarHeight = tasksBar.frame.height
        let add = element("tasks.add", in: app)
        XCTAssertTrue(add.waitForExistence(timeout: patience), "no add button on the tasks tab\n\(app.debugDescription)")
        add.tap()
        let formBar = app.navigationBars["新建任务"]
        XCTAssertTrue(formBar.waitForExistence(timeout: patience), "the new task form did not open\n\(app.debugDescription)")
        let inlineHeight = formBar.frame.height
        XCTAssertEqual(barFrame.height, inlineHeight, accuracy: 1, "the chat's bar (\(barFrame.height) pt) is not as tall as the system's inline bar (\(inlineHeight) pt; the tasks tab's bar with its large title is \(tasksBarHeight) pt)")
        element("task.form.cancel", in: app).tap()

        // Back on the chat nothing moved.
        app.tabBars.buttons["对话"].tap()
        XCTAssertTrue(bar.waitForExistence(timeout: patience), "no bar after coming back\n\(app.debugDescription)")
        XCTAssertEqual(bar.frame.height, barFrame.height, accuracy: 0.5)
        XCTAssertEqual(bar.frame.minY, barFrame.minY, accuracy: 0.5)
        XCTAssertEqual(avatar.frame.maxY, avatarFrame.maxY, accuracy: 0.5)
    }

    @MainActor
    func testTheMenuStillOffersUnpairing() throws {
        let app = try launchPaired()
        let menu = element("chat.header.menu", in: app)
        XCTAssertTrue(menu.waitForExistence(timeout: patience), "no menu button\n\(app.debugDescription)")
        menu.tap()
        XCTAssertTrue(app.buttons["取消配对"].waitForExistence(timeout: patience), "no 取消配对 in the menu\n\(app.debugDescription)")
    }

    /// Choosing 状态 in the menu sends `/status`, and Alfred answers it in the conversation. Nothing else is typed.
    @MainActor
    func testTheMenuSendsStatus() throws {
        let app = try launchPaired()
        let menu = element("chat.header.menu", in: app)
        XCTAssertTrue(menu.waitForExistence(timeout: patience), "no menu button\n\(app.debugDescription)")
        let known = messageIds(in: app)
        menu.tap()
        let status = app.buttons["状态"]
        XCTAssertTrue(status.waitForExistence(timeout: patience), "no 状态 in the menu\n\(app.debugDescription)")
        status.tap()
        XCTAssertTrue(newReply(known, in: app).waitForExistence(timeout: patience), "no /status reply\n\(app.debugDescription)")
    }

    /// With enough messages that the list scrolls, the first one, at the top of the list, is below the avatar and can be
    /// tapped: the list starts under the avatar's lower edge.
    @MainActor
    func testTheFirstMessageIsNotCoveredByTheAvatar() throws {
        let app = try launchPaired()
        let avatar = element("chat.header.avatar", in: app)
        XCTAssertTrue(avatar.waitForExistence(timeout: patience), "no avatar\n\(app.debugDescription)")

        // Enough `/status` replies to fill the screen. `/status` costs nothing.
        waitUntilStable { messageIds(in: app).count }
        for _ in 0..<8 {
            let known = messageIds(in: app)
            send("/status", in: app)
            XCTAssertTrue(newReply(known, in: app).waitForExistence(timeout: patience), "no /status reply\n\(app.debugDescription)")
        }

        // Scroll up until the topmost message stops moving: that is the start of the chat.
        var last: String?
        var steady = 0
        XCTAssertTrue(wait(timeout: patience * 4) {
            let now = topmostMessage(in: app).map { "\($0.identifier) \(Int($0.frame.minY))" }
            steady = now != nil && now == last ? steady + 1 : 0
            last = now
            if steady < 3 { app.swipeDown() }
            return steady >= 3
        }, "the list did not come to its start\n\(app.debugDescription)")

        let first = try XCTUnwrap(topmostMessage(in: app), "no message on screen")
        let message = element(first.identifier, in: app)
        XCTAssertGreaterThanOrEqual(message.frame.minY, avatar.frame.maxY, "the avatar covers the first message (\(first.identifier))")
        XCTAssertTrue(message.isHittable, "the first message cannot be hit (\(first.identifier))\n\(app.debugDescription)")

        // The chat at its start, and a little further down, where messages pass under the bar and the avatar.
        snapshotBothAppearances("chat-start", app)
        let from = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.6))
        from.press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.42)))
        usleep(1_000_000)
        snapshotBothAppearances("chat-under-bar", app)
    }

    // MARK: Screenshots

    /// Saves a screenshot of the app, in the light and in the dark appearance, when `ALFRED_SHOTS` names a directory:
    /// `<name>-light.png` and `<name>-dark.png`. The device goes back to the appearance it had.
    @MainActor
    private func snapshotBothAppearances(_ name: String, _ app: XCUIApplication) {
        guard let directory = ProcessInfo.processInfo.environment["ALFRED_SHOTS"], !directory.isEmpty else { return }
        let folder = URL(fileURLWithPath: directory, isDirectory: true)
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let original = XCUIDevice.shared.appearance
        defer { XCUIDevice.shared.appearance = original }
        for (suffix, appearance) in [("light", XCUIDevice.Appearance.light), ("dark", .dark)] {
            XCUIDevice.shared.appearance = appearance
            // The app restyles itself, and the scroll edge effect settles.
            usleep(1_500_000)
            try? XCUIScreen.main.screenshot().pngRepresentation.write(to: folder.appending(path: "\(name)-\(suffix).png"))
        }
    }

    // MARK: The list

    /// The message element highest up, among those the list has built: its identifier and frame.
    @MainActor
    private func topmostMessage(in app: XCUIApplication) -> (identifier: String, frame: CGRect)? {
        app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'message.'"))
            .allElementsBoundByIndex
            .filter { $0.exists && !$0.frame.isEmpty }
            .map { (identifier: $0.identifier, frame: $0.frame) }
            .min { $0.frame.minY < $1.frame.minY }
    }

    @MainActor
    private func send(_ text: String, in app: XCUIApplication) {
        let field = element("composer", in: app)
        field.tap()
        field.typeText(text)
        app.buttons["发送"].tap()
    }

    /// The identifiers of the stored messages on screen: `message.in.<id>` or `message.out.<id>`.
    @MainActor
    private func messageIds(in app: XCUIApplication) -> [String] {
        app.staticTexts.matching(NSPredicate(format: "identifier BEGINSWITH 'message.'"))
            .allElementsBoundByIndex.map(\.identifier)
            .filter { $0.hasPrefix("message.in.") || $0.hasPrefix("message.out.") }
    }

    /// A stored message from Alfred that is not among `known`.
    @MainActor
    private func newReply(_ known: [String], in app: XCUIApplication) -> XCUIElement {
        app.staticTexts.matching(NSPredicate(format: "identifier BEGINSWITH 'message.out.' AND NOT (identifier IN %@)", known)).firstMatch
    }

    /// Returns once `value` has stayed the same for a second, which is when the replay of old events is over.
    @MainActor
    private func waitUntilStable(_ value: () -> Int) {
        var last = value()
        var steady = 0
        let deadline = Date().addingTimeInterval(patience)
        while steady < 4, Date() < deadline {
            usleep(250_000)
            let now = value()
            steady = now == last ? steady + 1 : 0
            last = now
        }
    }

    // MARK: Pairing

    /// Launches the app, pairs it with the stack from the environment, and returns once the chat is connected.
    @MainActor
    private func launchPaired() throws -> XCUIApplication {
        guard let pairing = ProcessInfo.processInfo.environment["ALFRED_PAIRING"], !pairing.isEmpty else {
            throw XCTSkip("ALFRED_PAIRING is not set: start scripts/app-dev.ts and pass its pairing to run this test")
        }
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launch()
        unpairIfPaired(app)

        UIPasteboard.general.string = pairing
        let paste = app.buttons["粘贴配对信息"]
        XCTAssertTrue(paste.waitForExistence(timeout: patience), "the pairing screen has no paste button\n\(app.debugDescription)")
        paste.tap()

        XCTAssertTrue(app.tabBars.buttons["对话"].waitForExistence(timeout: patience), "the chat tab did not appear\n\(app.debugDescription)")
        XCTAssertTrue(element("composer", in: app).waitForExistence(timeout: patience))
        XCTAssertTrue(app.staticTexts["连接中…"].waitForNonExistence(timeout: patience), "the stream never connected")
        return app
    }

    /// Leaves the app on the pairing screen: a paired app unpairs through the menu, and one whose device the
    /// server no longer knows (the stack was restarted) pairs again from the failure screen.
    @MainActor
    private func unpairIfPaired(_ app: XCUIApplication) {
        let paste = app.buttons["粘贴配对信息"]
        let tab = app.tabBars.buttons["对话"]
        let repair = app.buttons["重新配对"]
        let deadline = Date().addingTimeInterval(patience)
        while Date() < deadline, !paste.exists, !tab.exists, !repair.exists {
            usleep(100_000)
        }
        if repair.exists {
            repair.tap()
        } else if tab.exists {
            let more = app.buttons["更多"]
            XCTAssertTrue(more.waitForExistence(timeout: patience), "no menu button\n\(app.debugDescription)")
            more.tap()
            let item = app.buttons["取消配对"]
            XCTAssertTrue(item.waitForExistence(timeout: patience), "no 取消配对 in the menu\n\(app.debugDescription)")
            item.tap()
            // The confirmation is a sheet with a button of the same name. Wait for that one: a tap on the first
            // button of that name can land on the menu item while it is still fading out.
            let confirm = app.sheets.buttons["取消配对"]
            XCTAssertTrue(confirm.waitForExistence(timeout: patience), "no confirmation sheet\n\(app.debugDescription)")
            confirm.tap()
        }
        XCTAssertTrue(paste.waitForExistence(timeout: patience), "the app did not return to pairing\n\(app.debugDescription)")
    }

    @MainActor
    private func element(_ identifier: String, in app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: identifier).firstMatch
    }

    /// Polls `condition` until it holds or `timeout` passes.
    @MainActor
    private func wait(timeout: TimeInterval, until condition: () -> Bool) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return true }
            usleep(250_000)
        }
        return condition()
    }
}
