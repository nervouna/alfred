import XCTest

/// Pairs the app with a running `node scripts/app-dev.ts --seed-documents` and annotates the seeded Markdown report: it
/// selects a word and comments on it, comments on the whole document, and finds both drafts again after the app is
/// launched anew. The second test has Alfred write and deliver a note, annotates it, submits the batch, follows the
/// revision to its end, reads the replies and undoes the revision; it runs the model on haiku. The pairing comes from the environment variable `ALFRED_PAIRING` (pass `TEST_RUNNER_ALFRED_PAIRING` to
/// xcodebuild); without it the tests skip themselves. The first test runs no model; the second one costs a few cents.
///
/// When `ALFRED_SHOTS` names a directory (pass `TEST_RUNNER_ALFRED_SHOTS`), the tests save screenshots of the screens
/// they pass through there.
final class AnnotationsUITests: XCTestCase {
    private let patience: TimeInterval = 30
    private let modelPatience: TimeInterval = 180

    private let reportTitle = "咖啡市场周报"
    /// The paragraph of the report's current version that the tests select a word in.
    private let paragraph = "本周豆价小幅上涨，进口量明显下降。"
    private let selectedComment = "这句话请写得更具体"
    private let editedComment = "这句话请写得更具体，加上数字"
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

        // A tap on the highlight opens its card, which says what the draft is; the draft can be edited there.
        highlight.tap()
        let cardComment = element("annotation.card.comment", in: app)
        XCTAssertTrue(cardComment.waitForExistence(timeout: patience), "the highlight did not open its card\n\(app.debugDescription)")
        XCTAssertEqual(cardComment.label, selectedComment)
        XCTAssertEqual(element("annotation.card.quote", in: app).label, selected)
        element("annotation.edit", in: app).tap()
        let field = element("annotation.sheet.comment", in: app)
        XCTAssertTrue(field.waitForExistence(timeout: patience), "the draft did not open for editing\n\(app.debugDescription)")
        XCTAssertEqual(field.value as? String, selectedComment, "the editor starts with the draft's comment")
        app.typeText("，加上数字")
        element("annotation.sheet.save", in: app).tap()
        XCTAssertTrue(wait(timeout: patience) { element("annotation.card.comment", in: app).label == editedComment }, "the card does not show the edited comment\n\(app.debugDescription)")
        snapshot("2b-card", app)
        element("annotation.card.done", in: app).tap()
        XCTAssertTrue(element("annotation.card.comment", in: app).waitForNonExistence(timeout: patience), "the card stayed open")
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
        XCTAssertTrue(app.staticTexts[editedComment].exists && app.staticTexts[wholeComment].exists, "the drafts lack their comments\n\(app.debugDescription)")
        XCTAssertTrue(app.staticTexts[selected].exists, "the draft on the passage does not quote it")

        // Delete the comment on the whole document; the other one stays.
        let delete = drafts.containing(NSPredicate(format: "label == %@", wholeComment)).firstMatch.buttons["删除"]
        XCTAssertTrue(delete.waitForExistence(timeout: patience), "no 删除 on the draft\n\(app.debugDescription)")
        delete.tap()
        XCTAssertTrue(wait(timeout: patience) { rows("annotation.row.drafts.", in: app).count == 1 }, "the draft was not deleted")
        XCTAssertFalse(app.staticTexts[wholeComment].exists)
        XCTAssertTrue(app.staticTexts[editedComment].exists)
        element("annotation.list.done", in: app).tap()
        XCTAssertTrue(wait(timeout: patience) { annotationCount(in: app) == "1" }, "the count is \(annotationCount(in: app))")
        XCTAssertEqual(element("annotation.submit", in: app).label, "提交 1 条批注")
    }


    @MainActor
    func testAnnotatingANoteGetsRepliesAndTheRevisionCanBeUndone() throws {
        let app = try launchPaired()
        // A note of its own, so a stack that already has documents does not disturb the test. Alfred delivers it in a chat run
        // on haiku, so the revision run of the document runs on haiku too.
        let tag = String(Int(Date().timeIntervalSince1970) % 100_000)
        let path = "notes/fruit-\(tag).md"
        let first = "苹果很甜。"
        let beforeAsk = messageIds(in: app)
        send("用 Write 在 \(path) 里写下这份 Markdown：第一行是 # 水果清单 \(tag)，空一行，下一行是 \(first)，再空一行，最后一行是 香蕉很软。 写好后用 deliver 把它发给我，然后只回复“发了”", in: app)
        XCTAssertTrue(newReply(beforeAsk, containing: "发了", in: app).waitForExistence(timeout: modelPatience), "Alfred did not deliver the note\n\(app.debugDescription)")
        let chips = app.descendants(matching: .any).matching(identifier: "file.chip.\(path)")
        XCTAssertTrue(chips.firstMatch.waitForExistence(timeout: patience), "no file chip for \(path)\n\(app.debugDescription)")
        let chip = try XCTUnwrap(chips.allElementsBoundByIndex.last)
        chip.tap()

        // Annotate a word of the first line and the whole document.
        let line = app.staticTexts[first]
        XCTAssertTrue(line.waitForExistence(timeout: patience), "the note did not open\n\(app.debugDescription)")
        line.doubleTap()
        let annotate = editMenuItem("批注", in: app)
        XCTAssertTrue(annotate.waitForExistence(timeout: patience), "no 批注 in the edit menu\n\(app.debugDescription)")
        annotate.tap()
        XCTAssertTrue(element("annotation.sheet.quote", in: app).waitForExistence(timeout: patience), "the comment sheet did not open\n\(app.debugDescription)")
        write("把这句改成英文", in: app)
        element("annotation.sheet.save", in: app).tap()
        XCTAssertTrue(element("annotation.sheet.save", in: app).waitForNonExistence(timeout: patience))
        element("document.annotateWhole", in: app).tap()
        XCTAssertTrue(element("annotation.sheet.comment", in: app).waitForExistence(timeout: patience))
        write("在文末加一行：完", in: app)
        element("annotation.sheet.save", in: app).tap()
        XCTAssertTrue(element("annotation.sheet.save", in: app).waitForNonExistence(timeout: patience))
        let submit = element("annotation.submit", in: app)
        XCTAssertTrue(wait(timeout: patience) { submit.exists && submit.label == "提交 2 条批注" }, "the submit button does not offer both drafts\n\(app.debugDescription)")
        snapshot("5-drafts-and-submit", app)

        // Submit: the drafts go, the banner shows while Alfred revises, and it goes when the run ends.
        submit.tap()
        let banner = element("revision.banner", in: app)
        XCTAssertTrue(banner.waitForExistence(timeout: patience), "no banner while Alfred revises\n\(app.debugDescription)")
        XCTAssertTrue(["排队修订中", "Alfred 正在修订"].contains(element("revision.banner.title", in: app).label), "the banner says \(element("revision.banner.title", in: app).label)")
        XCTAssertTrue(element("revision.stop", in: app).exists, "the banner has no 停止")
        XCTAssertFalse(submit.exists, "the drafts were submitted, so there is nothing to submit")
        snapshot("6-revision-banner", app)
        XCTAssertTrue(banner.waitForNonExistence(timeout: modelPatience), "the revision never ended\n\(app.debugDescription)")

        // Both annotations show Alfred's reply under 已回复.
        element("document.annotations", in: app).tap()
        let answered = rows("annotation.row.resolved.", in: app)
        XCTAssertTrue(wait(timeout: modelPatience) { answered.count == 2 }, "the list holds \(answered.count) answered annotations\n\(app.debugDescription)")
        XCTAssertTrue(element("annotation.section.resolved", in: app).exists)
        XCTAssertEqual(rows("annotation.card.reply", in: app).count, 2, "each answered annotation shows its reply")
        snapshot("7-replies", app)
        element("annotation.list.done", in: app).tap()

        // The chip opened the version Alfred delivered, which stays on screen under its notice; the revised one is a tap away.
        let latest = element("document.banner.current", in: app)
        XCTAssertTrue(latest.waitForExistence(timeout: patience), "the screen does not say there is a newer version\n\(app.debugDescription)")
        latest.tap()
        XCTAssertTrue(element("document.banner", in: app).waitForNonExistence(timeout: patience), "the current version did not open")

        // The revision made a version, and the menu offers to undo it, behind a confirmation that names the version's time.
        let menu = element("document.menu", in: app)
        XCTAssertTrue(menu.waitForExistence(timeout: patience), "no menu for the revised version\n\(app.debugDescription)")
        menu.tap()
        let undo = element("document.undo", in: app)
        XCTAssertTrue(undo.waitForExistence(timeout: patience), "no 撤销这次修订\n\(app.debugDescription)")
        undo.tap()
        let confirm = app.buttons["撤销修订"]
        XCTAssertTrue(confirm.waitForExistence(timeout: patience), "no confirmation\n\(app.debugDescription)")
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH '撤销 ' AND label ENDSWITH '的这次修订？'")).firstMatch.exists, "the confirmation does not name the version's time\n\(app.debugDescription)")
        snapshot("8-undo-confirmation", app)
        confirm.tap()

        // The document is back at a new, undone version, and the batch is under 已退回 with 已撤销.
        XCTAssertTrue(menu.waitForNonExistence(timeout: patience), "the menu still offers an undo after the undo\n\(app.debugDescription)")
        XCTAssertTrue(app.staticTexts[first].waitForExistence(timeout: patience), "the first line is not back\n\(app.debugDescription)")
        element("document.annotations", in: app).tap()
        let returned = rows("annotation.row.returned.", in: app)
        XCTAssertTrue(wait(timeout: patience) { returned.count == 2 }, "the list holds \(returned.count) returned annotations\n\(app.debugDescription)")
        let reasons = rows("annotation.card.reason", in: app).allElementsBoundByIndex.map(\.label)
        XCTAssertEqual(reasons, ["已撤销", "已撤销"], "each returned annotation says why")
        XCTAssertEqual(rows("annotation.row.resolved.", in: app).count, 0, "an undone revision answers nothing")
        XCTAssertTrue(element("annotation.section.returned", in: app).exists)
        snapshot("9-returned", app)
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

    // MARK: Chat

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
        app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'message.'"))
            .allElementsBoundByIndex.map(\.identifier)
            .filter { $0.hasPrefix("message.in.") || $0.hasPrefix("message.out.") }
    }

    /// A stored message from Alfred that is not among `known`, with text containing `fragment`.
    @MainActor
    private func newReply(_ known: [String], containing fragment: String, in app: XCUIApplication) -> XCUIElement {
        let fresh = NSPredicate(format: "identifier BEGINSWITH 'message.out.' AND NOT (identifier IN %@)", known)
        let matching = NSPredicate(format: "label CONTAINS %@", fragment)
        return app.descendants(matching: .any).matching(NSCompoundPredicate(andPredicateWithSubpredicates: [fresh, matching])).firstMatch
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
