import XCTest

/// Pairs the app with a running `scripts/app-dev.ts --seed-long-chat` (100 messages, every fifth reply of Alfred's long and so
/// collapsed) and scrolls up through them: the list stays where the owner scrolled to and does not go back to the end by
/// itself, which it did when a collapsing bubble changed the height of the content after it was laid out. It runs no model.
/// The pairing comes from the environment variable `ALFRED_PAIRING` (pass `TEST_RUNNER_ALFRED_PAIRING` to xcodebuild);
/// without it the test skips itself.
final class ChatScrollCollapsedUITests: XCTestCase {
    private let patience: TimeInterval = 30
    /// The newest message of the seed, a collapsed one.
    private let newest = "message.out.seed-100"

    @MainActor
    func testScrollingUpPastCollapsedMessagesStaysWhereTheOwnerScrolledTo() throws {
        let app = try launchPaired()
        let latest = element("chat.latest", in: app)
        let list = app.scrollViews.firstMatch
        XCTAssertTrue(element(newest, in: app).waitForExistence(timeout: patience), "the newest message is not on screen\n\(app.debugDescription)")
        XCTAssertFalse(latest.exists, "the button shows while the list is at its end\n\(app.debugDescription)")

        // Several screens up, one swipe at a time, so the list creates the rows it passes. Once the button shows, every
        // swipe must leave it there: the list never goes back to the end on its own.
        list.swipeDown(velocity: .fast)
        XCTAssertTrue(latest.waitForExistence(timeout: patience), "no button after scrolling up\n\(app.debugDescription)")
        for swipe in 2...14 {
            list.swipeDown(velocity: .fast)
            usleep(400_000)
            XCTAssertTrue(latest.exists, "the list went back to the end during swipe \(swipe)\n\(app.debugDescription)")
        }

        // It comes to rest and stays there.
        let shown = restingMessageIds(in: app)
        XCTAssertFalse(shown.isEmpty, "no message is on screen after scrolling up\n\(app.debugDescription)")
        sleep(3)
        XCTAssertTrue(latest.exists, "the list went back to the end by itself\n\(app.debugDescription)")
        XCTAssertFalse(element(newest, in: app).isHittable, "the newest message is on screen again\n\(app.debugDescription)")
        XCTAssertEqual(hittableMessageIds(in: app), shown, "the list moved while it rested\n\(app.debugDescription)")
    }

    /// The identifiers of the stored messages on screen, once they stay the same for a second.
    @MainActor
    private func restingMessageIds(in app: XCUIApplication) -> [String] {
        var last = hittableMessageIds(in: app)
        var steady = 0
        let deadline = Date().addingTimeInterval(patience)
        while steady < 4, Date() < deadline {
            usleep(250_000)
            let now = hittableMessageIds(in: app)
            steady = now == last ? steady + 1 : 0
            last = now
        }
        return last
    }

    /// The identifiers of the stored messages the user can touch: `message.in.<id>` or `message.out.<id>`.
    @MainActor
    private func hittableMessageIds(in app: XCUIApplication) -> [String] {
        app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'message.'"))
            .allElementsBoundByIndex
            .filter { ($0.identifier.hasPrefix("message.in.") || $0.identifier.hasPrefix("message.out.")) && $0.isHittable }
            .map(\.identifier)
            .sorted()
    }

    // MARK: Pairing

    @MainActor
    private func launchPaired() throws -> XCUIApplication {
        guard let pairing = ProcessInfo.processInfo.environment["ALFRED_PAIRING"], !pairing.isEmpty else {
            throw XCTSkip("ALFRED_PAIRING is not set: start scripts/app-dev.ts --seed-long-chat and pass its pairing to run this test")
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

    /// Leaves the app on the pairing screen: a paired app unpairs through the menu, and one whose device the server no
    /// longer knows pairs again from the failure screen.
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
}
