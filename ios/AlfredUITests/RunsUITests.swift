import XCTest

/// Pairs the app with a running `scripts/app-dev.ts`, has Alfred write a file, and follows it through the 任务 tab and
/// the viewer. The pairing comes from the environment variable `ALFRED_PAIRING` (pass
/// `TEST_RUNNER_ALFRED_PAIRING` to xcodebuild); without it the tests skip themselves, so CI and plain test runs
/// need no stack. Each test runs the model once, for about a tenth of a cent.
final class RunsUITests: XCTestCase {
    private let patience: TimeInterval = 30
    private let modelPatience: TimeInterval = 120

    @MainActor
    func testARunShowsItsFileInTheRunsTab() throws {
        let app = try launchPaired()

        // The stack may hold runs from an earlier test; this one looks for the run it starts.
        openTab("任务", in: app)
        let knownRuns = settledRunRows(in: app)

        openTab("对话", in: app)
        let beforeAsk = messageIds(in: app)
        send("在 notes/hi.md 里写一行“你好”，然后只回复“好了”", in: app)
        XCTAssertTrue(newReply(beforeAsk, containing: "好了", in: app).waitForExistence(timeout: modelPatience), "Alfred did not answer\n\(app.debugDescription)")

        // The 任务 tab lists the run, finished.
        openTab("任务", in: app)
        let row = try newRunRow(excluding: knownRuns, in: app)
        XCTAssertTrue(wait(timeout: patience) { row.label.contains("完成") }, "the run never showed as 完成: \(row.label)")

        // Its detail lists the file it wrote, and the file opens.
        row.tap()
        let file = element("run.file.notes/hi.md", in: app)
        XCTAssertTrue(file.waitForExistence(timeout: patience), "the run's detail does not list notes/hi.md\n\(app.debugDescription)")
        file.tap()
        XCTAssertTrue(shows("你好", in: app), "the viewer does not show the file\n\(app.debugDescription)")
        XCTAssertTrue(element("viewer.markdown", in: app).exists, "a Markdown file opens in the Markdown viewer")
        XCTAssertTrue(app.buttons["viewer.share"].exists || app.buttons["Share"].exists, "the viewer has no share button\n\(app.debugDescription)")
    }

    @MainActor
    func testAFileChipInTheChatOpensTheViewer() throws {
        let app = try launchPaired()

        let beforeAsk = messageIds(in: app)
        send("在 notes/chip.md 里写一行“你好，附件”，用 deliver 把它发给我，然后只回复“发了”", in: app)
        XCTAssertTrue(newReply(beforeAsk, in: app).waitForExistence(timeout: modelPatience), "Alfred did not answer\n\(app.debugDescription)")

        // An earlier run of this test left chips for the same file higher up; the one just sent is the last.
        let chips = app.descendants(matching: .any).matching(identifier: "file.chip.notes/chip.md")
        XCTAssertTrue(chips.firstMatch.waitForExistence(timeout: patience), "no file chip for notes/chip.md\n\(app.debugDescription)")
        let chip = try XCTUnwrap(chips.allElementsBoundByIndex.last)
        chip.tap()
        XCTAssertTrue(shows("你好，附件", in: app), "the chip does not open the viewer\n\(app.debugDescription)")
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
        XCTAssertTrue(composer(in: app).waitForExistence(timeout: patience))
        XCTAssertTrue(app.staticTexts["连接中…"].waitForNonExistence(timeout: patience), "the stream never connected")
        // The stream replays what an earlier test left on the stack.
        waitUntilStable { messageIds(in: app).count }
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

    // MARK: Chat

    @MainActor
    private func composer(in app: XCUIApplication) -> XCUIElement {
        element("composer", in: app)
    }

    @MainActor
    private func send(_ text: String, in app: XCUIApplication) {
        let field = composer(in: app)
        field.tap()
        field.typeText(text)
        app.buttons["发送"].tap()
    }

    /// Opens a tab. The composer keeps the keyboard after a send, and the keyboard covers the tab bar, so it goes first.
    @MainActor
    private func openTab(_ name: String, in app: XCUIApplication) {
        // The message list dismisses the keyboard when it is dragged down into it.
        if app.keyboards.count > 0 {
            let top = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.25))
            let bottom = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.98))
            top.press(forDuration: 0.1, thenDragTo: bottom)
            XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: patience), "the keyboard stayed up")
        }
        app.tabBars.buttons[name].tap()
    }

    /// The identifiers of the stored messages on screen: `message.in.<id>` or `message.out.<id>`.
    @MainActor
    private func messageIds(in app: XCUIApplication) -> [String] {
        app.staticTexts.matching(NSPredicate(format: "identifier BEGINSWITH 'message.'"))
            .allElementsBoundByIndex.map(\.identifier)
            .filter { $0.hasPrefix("message.in.") || $0.hasPrefix("message.out.") }
    }

    /// A stored message from Alfred that is not among `known`, with text containing `fragment` when there is one.
    @MainActor
    private func newReply(_ known: [String], containing fragment: String? = nil, in app: XCUIApplication) -> XCUIElement {
        let fresh = NSPredicate(format: "identifier BEGINSWITH 'message.out.' AND NOT (identifier IN %@)", known)
        guard let fragment else { return app.staticTexts.matching(fresh).firstMatch }
        let matching = NSPredicate(format: "label CONTAINS %@", fragment)
        return app.staticTexts.matching(NSCompoundPredicate(andPredicateWithSubpredicates: [fresh, matching])).firstMatch
    }

    // MARK: Runs

    /// The ids of the runs on the 任务 tab, once its list has stopped changing.
    @MainActor
    private func settledRunRows(in app: XCUIApplication) -> Set<String> {
        _ = wait(timeout: patience) { !runRowIds(in: app).isEmpty || app.staticTexts["还没有运行"].exists }
        waitUntilStable { runRowIds(in: app).count }
        return Set(runRowIds(in: app))
    }

    @MainActor
    private func runRowIds(in app: XCUIApplication) -> [String] {
        app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'run.row.'"))
            .allElementsBoundByIndex.map(\.identifier)
    }

    /// The row of a run that is not among `known`.
    @MainActor
    private func newRunRow(excluding known: Set<String>, in app: XCUIApplication) throws -> XCUIElement {
        var fresh: String?
        XCTAssertTrue(wait(timeout: patience) {
            fresh = runRowIds(in: app).first { !known.contains($0) }
            return fresh != nil
        }, "the 任务 tab shows no new run\n\(app.debugDescription)")
        return element(try XCTUnwrap(fresh), in: app)
    }

    // MARK: Waiting

    @MainActor
    private func element(_ identifier: String, in app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: identifier).firstMatch
    }

    /// Whether some text on screen contains `fragment`, within the wait for server replies.
    @MainActor
    private func shows(_ fragment: String, in app: XCUIApplication) -> Bool {
        let text = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", fragment)).firstMatch
        return text.waitForExistence(timeout: patience)
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

    /// Returns once `value` has stayed the same for a second.
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
}
