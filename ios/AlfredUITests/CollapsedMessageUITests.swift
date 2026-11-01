import XCTest

/// Pairs the app with a running `scripts/app-dev.ts --seed-long-message` and looks at a long message of Alfred's: the chat
/// shows it cut off at about ten lines, a tap opens the whole message in a full-screen reader, and the reader's close button
/// returns to the chat. A short message does not react to a tap. It runs no model. The pairing comes from the environment
/// variable `ALFRED_PAIRING` (pass `TEST_RUNNER_ALFRED_PAIRING` to xcodebuild); without it the test skips itself.
///
/// The long message is 24 paragraphs `第 n 段` and a last one, `最后一行`.
final class CollapsedMessageUITests: XCTestCase {
    private let patience: TimeInterval = 30
    private let lastLine = "最后一行"

    @MainActor
    func testALongMessageCollapsesAndOpensInTheReader() throws {
        let app = try launchPaired()
        let long = element("message.out.seed-long-3", in: app)
        let short = element("message.out.seed-long-2", in: app)
        XCTAssertTrue(long.waitForExistence(timeout: patience), "the long message is not in the chat\n\(app.debugDescription)")
        XCTAssertTrue(short.exists, "the short message is not in the chat\n\(app.debugDescription)")

        // Collapsed: the bubble is about ten lines high (a body line is ~20 pt; 24 paragraphs are far taller), its text
        // keeps the whole message for VoiceOver, and its last line is not a separate thing on screen.
        XCTAssertLessThan(long.frame.height, 300, "the long message is not collapsed: \(long.frame)")
        XCTAssertGreaterThan(long.frame.height, 150, "the collapsed message is too short: \(long.frame)")
        XCTAssertTrue(long.label.contains(lastLine), "the collapsed message lost its text: \(long.label)")
        assertLastLineIsCut(of: long, in: app)

        // A message that is not collapsed does not react to a tap.
        short.tap()
        XCTAssertFalse(close(in: app).waitForExistence(timeout: 2), "a short message opened the reader\n\(app.debugDescription)")

        // A tap opens the reader, where the last line can be reached by scrolling.
        long.tap()
        let close = close(in: app)
        XCTAssertTrue(close.waitForExistence(timeout: patience), "the reader did not open\n\(app.debugDescription)")
        XCTAssertTrue(element("reader.copy", in: app).exists, "the reader has no copy button\n\(app.debugDescription)")
        // The chat behind the reader stays in the accessibility tree: look in the reader's own scroll view.
        let reader = app.scrollViews["reader.scroll"]
        XCTAssertTrue(reader.waitForExistence(timeout: patience), "the reader has no scroll view\n\(app.debugDescription)")
        let last = reader.staticTexts[lastLine]
        for _ in 0..<8 where !(last.exists && last.isHittable) {
            reader.swipeUp()
        }
        XCTAssertTrue(last.exists && last.isHittable, "the last line is not reachable in the reader\n\(app.debugDescription)")

        // Closing returns to the chat.
        close.tap()
        XCTAssertTrue(close.waitForNonExistence(timeout: patience), "the reader stayed open\n\(app.debugDescription)")
        XCTAssertTrue(long.waitForExistence(timeout: patience), "the chat did not return\n\(app.debugDescription)")
        assertLastLineIsCut(of: long, in: app)
    }

    /// The cut-off text stays in the accessibility tree, but below the bubble's bottom edge, where it is not drawn.
    @MainActor
    private func assertLastLineIsCut(of bubble: XCUIElement, in app: XCUIApplication) {
        let last = app.staticTexts[lastLine]
        XCTAssertTrue(!last.exists || last.frame.minY >= bubble.frame.maxY, "the last line is inside the bubble: \(last.frame), \(bubble.frame)\n\(app.debugDescription)")
    }

    @MainActor
    private func close(in app: XCUIApplication) -> XCUIElement {
        element("reader.close", in: app)
    }

    // MARK: Pairing

    @MainActor
    private func launchPaired() throws -> XCUIApplication {
        guard let pairing = ProcessInfo.processInfo.environment["ALFRED_PAIRING"], !pairing.isEmpty else {
            throw XCTSkip("ALFRED_PAIRING is not set: start scripts/app-dev.ts --seed-long-message and pass its pairing to run this test")
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
