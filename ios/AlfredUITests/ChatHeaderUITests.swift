import XCTest

/// Pairs the app with a running `scripts/app-dev.ts` and looks at the chat's header: a round button on each side, the
/// avatar in the middle, taller than the bar and hanging over the messages. It runs no model (`/status` is answered by
/// Alfred itself). The pairing comes from the environment variable `ALFRED_PAIRING` (pass `TEST_RUNNER_ALFRED_PAIRING` to
/// xcodebuild); without it the tests skip themselves.
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

    @MainActor
    func testTheMenuStillOffersUnpairing() throws {
        let app = try launchPaired()
        let menu = element("chat.header.menu", in: app)
        XCTAssertTrue(menu.waitForExistence(timeout: patience), "no menu button\n\(app.debugDescription)")
        menu.tap()
        XCTAssertTrue(app.buttons["取消配对"].waitForExistence(timeout: patience), "no 取消配对 in the menu\n\(app.debugDescription)")
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
