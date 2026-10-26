import XCTest

/// Pairs the app with a running `node scripts/app-dev.ts --seed-documents` and annotates the seeded Markdown report: it
/// selects a word and comments on it, comments on the whole document, and finds both drafts again after the app is
/// launched anew. The pairing comes from the environment variable `ALFRED_PAIRING` (pass `TEST_RUNNER_ALFRED_PAIRING` to
/// xcodebuild); without it the tests skip themselves. The first test runs no model.
///
/// When `ALFRED_SHOTS` names a directory (pass `TEST_RUNNER_ALFRED_SHOTS`), the tests save screenshots of the screens
/// they pass through there.
final class AnnotationsUITests: XCTestCase {
    private let patience: TimeInterval = 30

    private let reportTitle = "咖啡市场周报"
    /// The paragraph of the report's current version that the tests select a word in.
    private let paragraph = "本周豆价小幅上涨，进口量明显下降。"
    private let selectedComment = "这句话请写得更具体"
    private let wholeComment = "整篇报告的语气再正式一些"

    @MainActor
    func testDraftsSurviveARelaunchAndCanBeDeleted() throws {
        let app = try launchPaired()
        openTab("文档", in: app)
        try documentRow(titled: reportTitle, in: app).tap()
        let text = app.staticTexts[paragraph]
        XCTAssertTrue(text.waitForExistence(timeout: patience), "the report did not open\n\(app.debugDescription)")
        XCTAssertEqual(annotationCount(in: app), "0", "a new stack has no annotations")
        XCTAssertFalse(element("annotation.submit", in: app).exists, "nothing to submit yet")

        // Select a word of the paragraph: a double tap selects the word and shows the edit menu, where 批注 sits with the system's actions.
        text.doubleTap()
        let annotate = editMenuItem("批注", in: app)
        XCTAssertTrue(annotate.waitForExistence(timeout: patience), "no 批注 in the edit menu\n\(app.debugDescription)")
        snapshot("1-selection-menu", app)
        annotate.tap()

        // The sheet quotes the selected word. Write the comment and keep it as a draft.
        let quote = element("annotation.sheet.quote", in: app)
        XCTAssertTrue(quote.waitForExistence(timeout: patience), "the comment sheet did not open\n\(app.debugDescription)")
        let selected = quote.label
        XCTAssertFalse(selected.isEmpty, "the sheet does not quote the selection")
        XCTAssertTrue(paragraph.contains(selected), "the quote '\(selected)' is not in the paragraph")
        XCTAssertFalse(element("annotation.sheet.save", in: app).isEnabled, "an empty comment cannot be saved")
        write(selectedComment, in: app)
        snapshot("2-comment-sheet", app)
        element("annotation.sheet.save", in: app).tap()
        XCTAssertTrue(element("annotation.sheet.save", in: app).waitForNonExistence(timeout: patience), "the sheet stayed open")

        // The passage is highlighted as a draft, and the count on the toolbar is 1.
        let highlight = element("annotation.highlight.", in: app, prefix: true)
        XCTAssertTrue(highlight.waitForExistence(timeout: patience), "no highlight over the passage\n\(app.debugDescription)")
        XCTAssertEqual(highlight.label, "草稿")
        XCTAssertEqual(highlight.value as? String, selected)
        XCTAssertTrue(wait(timeout: patience) { annotationCount(in: app) == "1" }, "the count is \(annotationCount(in: app))")
        XCTAssertEqual(element("annotation.submit", in: app).label, "提交 1 条批注")

        // A comment on the whole document.
        element("document.annotateWhole", in: app).tap()
        XCTAssertTrue(element("annotation.sheet.comment", in: app).waitForExistence(timeout: patience), "the sheet did not open\n\(app.debugDescription)")
        XCTAssertFalse(element("annotation.sheet.quote", in: app).exists, "a comment on the whole document quotes nothing")
        write(wholeComment, in: app)
        element("annotation.sheet.save", in: app).tap()
        XCTAssertTrue(element("annotation.sheet.save", in: app).waitForNonExistence(timeout: patience))
        XCTAssertTrue(wait(timeout: patience) { annotationCount(in: app) == "2" }, "the count is \(annotationCount(in: app))")
        XCTAssertEqual(element("annotation.submit", in: app).label, "提交 2 条批注")
        snapshot("3-drafts", app)

        // The drafts are on the phone: they are still there after the app is launched anew.
        app.terminate()
        app.launch()
        XCTAssertTrue(app.tabBars.buttons["文档"].waitForExistence(timeout: patience), "the app did not come back paired\n\(app.debugDescription)")
        openTab("文档", in: app)
        try documentRow(titled: reportTitle, in: app).tap()
        XCTAssertTrue(app.staticTexts[paragraph].waitForExistence(timeout: patience), "the report did not open again\n\(app.debugDescription)")
        XCTAssertTrue(wait(timeout: patience) { annotationCount(in: app) == "2" }, "the drafts did not survive the relaunch: \(annotationCount(in: app))")
        XCTAssertTrue(element("annotation.highlight.", in: app, prefix: true).waitForExistence(timeout: patience), "the passage is not highlighted again")

        element("document.annotations", in: app).tap()
        let drafts = rows("annotation.row.drafts.", in: app)
        XCTAssertTrue(wait(timeout: patience) { drafts.count == 2 }, "the list holds \(drafts.count) drafts\n\(app.debugDescription)")
        XCTAssertTrue(element("annotation.section.drafts", in: app).exists)
        snapshot("4-list", app)
        XCTAssertTrue(app.staticTexts[selectedComment].exists && app.staticTexts[wholeComment].exists, "the drafts lack their comments\n\(app.debugDescription)")
        XCTAssertTrue(app.staticTexts[selected].exists, "the draft on the passage does not quote it")

        // Delete the comment on the whole document; the other one stays.
        let delete = drafts.containing(NSPredicate(format: "label == %@", wholeComment)).firstMatch.buttons["删除"]
        XCTAssertTrue(delete.waitForExistence(timeout: patience), "no 删除 on the draft\n\(app.debugDescription)")
        delete.tap()
        XCTAssertTrue(wait(timeout: patience) { rows("annotation.row.drafts.", in: app).count == 1 }, "the draft was not deleted")
        XCTAssertFalse(app.staticTexts[wholeComment].exists)
        XCTAssertTrue(app.staticTexts[selectedComment].exists)
        element("annotation.list.done", in: app).tap()
        XCTAssertTrue(wait(timeout: patience) { annotationCount(in: app) == "1" }, "the count is \(annotationCount(in: app))")
        XCTAssertEqual(element("annotation.submit", in: app).label, "提交 1 条批注")
    }

    // MARK: The screen

    /// The number on the 批注列表 button.
    @MainActor
    private func annotationCount(in app: XCUIApplication) -> String {
        (element("document.annotations", in: app).value as? String) ?? "?"
    }

    /// Types into the comment field of the open sheet.
    @MainActor
    private func write(_ comment: String, in app: XCUIApplication) {
        let field = element("annotation.sheet.comment", in: app)
        XCTAssertTrue(field.waitForExistence(timeout: patience), "no comment field\n\(app.debugDescription)")
        field.tap()
        field.typeText(comment)
    }

    /// An item of the edit menu over a selection.
    @MainActor
    private func editMenuItem(_ title: String, in app: XCUIApplication) -> XCUIElement {
        let kinds = [XCUIElement.ElementType.menuItem, .button].map { String($0.rawValue) }.joined(separator: ", ")
        return app.descendants(matching: .any)
            .matching(NSPredicate(format: "label == %@ AND elementType IN {\(kinds)}", title)).firstMatch
    }

    /// The rows of the list whose identifier starts with `prefix`.
    @MainActor
    private func rows(_ prefix: String, in app: XCUIApplication) -> XCUIElementQuery {
        app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", prefix))
    }

    /// The row of the document with this title.
    @MainActor
    private func documentRow(titled title: String, in app: XCUIApplication) throws -> XCUIElement {
        let row = app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier BEGINSWITH 'document.row.' AND label CONTAINS %@", title)).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: patience), "the 文档 tab does not list \(title)\n\(app.debugDescription)")
        return row
    }

    // MARK: Screenshots

    /// Saves a screenshot of the app when `ALFRED_SHOTS` names a directory.
    @MainActor
    private func snapshot(_ name: String, _ app: XCUIApplication) {
        guard let directory = ProcessInfo.processInfo.environment["ALFRED_SHOTS"], !directory.isEmpty else { return }
        let folder = URL(fileURLWithPath: directory, isDirectory: true)
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try? XCUIScreen.main.screenshot().pngRepresentation.write(to: folder.appending(path: name + ".png"))
    }

    // MARK: Pairing

    /// Launches the app, pairs it with the stack from the environment, and returns once the chat is connected.
    @MainActor
    private func launchPaired() throws -> XCUIApplication {
        guard let pairing = ProcessInfo.processInfo.environment["ALFRED_PAIRING"], !pairing.isEmpty else {
            throw XCTSkip("ALFRED_PAIRING is not set: start scripts/app-dev.ts --seed-documents and pass its pairing to run this test")
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

    // MARK: Waiting

    @MainActor
    private func openTab(_ name: String, in app: XCUIApplication) {
        app.tabBars.buttons[name].tap()
    }

    @MainActor
    private func element(_ identifier: String, in app: XCUIApplication, prefix: Bool = false) -> XCUIElement {
        if prefix {
            return app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", identifier)).firstMatch
        }
        return app.descendants(matching: .any).matching(identifier: identifier).firstMatch
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
