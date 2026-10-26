import XCTest

/// Pairs the app with a running `node scripts/app-dev.ts --seed-documents` and works the 文档 tab: the seeded Markdown
/// report (three versions: delivered, revised, changed) and HTML report (one version). The pairing comes from the
/// environment variable `ALFRED_PAIRING` (pass `TEST_RUNNER_ALFRED_PAIRING` to xcodebuild); without it the tests skip
/// themselves. Nothing here runs the model.
final class DocumentsUITests: XCTestCase {
    private let patience: TimeInterval = 30

    private let reportTitle = "咖啡市场周报"
    private let pageTitle = "价格总览"
    // What each version of the report says in the block that tells the versions apart.
    private let summaryOfFirst = "本周豆价基本持平，进口量略有下降。"
    private let summaryOfLater = "本周豆价小幅上涨，进口量明显下降。"
    private let outlookOfFirst = "展望"
    private let outlookOfThird = "下周展望"
    private let riskAdded = "主要风险是产区天气。"

    @MainActor
    func testTheTabListsBothSeededDocuments() throws {
        let app = try launchPaired()
        openTab("文档", in: app)

        let report = try documentRow(titled: reportTitle, in: app)
        let page = try documentRow(titled: pageTitle, in: app)
        XCTAssertTrue(report.label.contains("reports"), "the row does not show the folder: \(report.label)")
        XCTAssertTrue(page.label.contains("reports"), "the row does not show the folder: \(page.label)")
        // Newest updated first: the report's last version is newer than the page.
        XCTAssertLessThan(report.frame.minY, page.frame.minY, "the report was updated last and should come first")
    }

    @MainActor
    func testTheReportOpensAtItsThirdVersionAndItsVersionsAreListed() throws {
        let app = try launchPaired()
        openTab("文档", in: app)
        try documentRow(titled: reportTitle, in: app).tap()

        // The current version: the third, whose heading was changed. It has no banner.
        XCTAssertTrue(app.staticTexts[outlookOfThird].waitForExistence(timeout: patience), "the third version is not on screen\n\(app.debugDescription)")
        XCTAssertFalse(app.staticTexts[outlookOfFirst].exists, "the old heading is still on screen")
        XCTAssertFalse(element("document.banner", in: app).exists, "the current version has no banner")

        // 版本 lists the three versions, newest first, with what made each.
        openVersions(in: app)
        let third = element("document.version.3", in: app)
        let second = element("document.version.2", in: app)
        let first = element("document.version.1", in: app)
        XCTAssertTrue(third.exists && second.exists && first.exists, "the list does not hold three versions\n\(app.debugDescription)")
        XCTAssertFalse(element("document.version.4", in: app).exists, "the list holds more than three versions")
        XCTAssertTrue(third.label.contains("修改") && third.label.contains("当前"), "the third version is the current one, made by a change: \(third.label)")
        XCTAssertTrue(second.label.contains("修订"), "the second version was revised: \(second.label)")
        XCTAssertTrue(first.label.contains("交付"), "the first version was delivered: \(first.label)")
        XCTAssertTrue(second.label.contains("运行 "), "a version shows the run that made it: \(second.label)")
        XCTAssertLessThan(third.frame.minY, second.frame.minY)
        XCTAssertLessThan(second.frame.minY, first.frame.minY)

        // The first version opens read-only, under its banner, with nothing marked, and the button goes back.
        first.tap()
        let title = element("document.banner.title", in: app)
        XCTAssertTrue(title.waitForExistence(timeout: patience), "no banner over the old version\n\(app.debugDescription)")
        XCTAssertEqual(title.label, "正在查看第 1 版（交付）")
        XCTAssertTrue(app.staticTexts[summaryOfFirst].waitForExistence(timeout: patience), "the first version is not on screen\n\(app.debugDescription)")
        XCTAssertTrue(app.staticTexts[outlookOfFirst].exists)
        XCTAssertFalse(app.staticTexts[outlookOfThird].exists, "the current version's heading is on screen over the first version")
        XCTAssertEqual(markedBlocks(in: app).count, 0, "the first version marks nothing")

        element("document.banner.current", in: app).tap()
        XCTAssertTrue(app.staticTexts[outlookOfThird].waitForExistence(timeout: patience), "the button did not go back to the current version\n\(app.debugDescription)")
        XCTAssertTrue(element("document.banner", in: app).waitForNonExistence(timeout: patience), "the banner stayed over the current version")
    }

    @MainActor
    func testTheSecondVersionMarksTwoBlocksAndTheThirdOne() throws {
        let app = try launchPaired()
        openTab("文档", in: app)
        try documentRow(titled: reportTitle, in: app).tap()
        XCTAssertTrue(app.staticTexts[outlookOfThird].waitForExistence(timeout: patience), "the report did not open\n\(app.debugDescription)")

        // The third version changed a heading against the second.
        XCTAssertTrue(wait(timeout: patience) { markedBlocks(in: app).count == 1 }, "the third version does not mark its one changed block: \(markedBlocks(in: app).count)\n\(app.debugDescription)")
        XCTAssertEqual(markedBlocks(in: app).first?.label, "已修改")

        // The second version changed a paragraph and added one.
        openVersions(in: app)
        element("document.version.2", in: app).tap()
        XCTAssertEqual(element("document.banner.title", in: app).label, "正在查看第 2 版（修订）")
        XCTAssertTrue(app.staticTexts[summaryOfLater].waitForExistence(timeout: patience), "the second version is not on screen\n\(app.debugDescription)")
        XCTAssertTrue(app.staticTexts[riskAdded].exists)
        XCTAssertTrue(wait(timeout: patience) { markedBlocks(in: app).count == 2 }, "the second version does not mark two blocks: \(markedBlocks(in: app).count)\n\(app.debugDescription)")
        // The marks sit on the changed paragraph and the added one, not on the heading before the added paragraph.
        let marks = markedBlocks(in: app).map(\.frame.midY).sorted()
        let changed = app.staticTexts[summaryOfLater].frame
        let added = app.staticTexts[riskAdded].frame
        XCTAssertTrue(changed.minY <= marks[0] && marks[0] <= changed.maxY, "the first mark is not beside the changed paragraph")
        XCTAssertTrue(added.minY <= marks[1] && marks[1] <= added.maxY, "the second mark is not beside the added paragraph")
    }

    @MainActor
    func testTheHTMLReportHasOneVersionAndOpensInTheReportViewer() throws {
        let app = try launchPaired()
        openTab("文档", in: app)
        try documentRow(titled: pageTitle, in: app).tap()

        XCTAssertTrue(element("viewer.report", in: app).waitForExistence(timeout: patience), "the HTML report did not open in the report viewer\n\(app.debugDescription)")
        XCTAssertFalse(element("document.banner", in: app).exists)

        openVersions(in: app)
        XCTAssertTrue(element("document.version.1", in: app).exists)
        XCTAssertFalse(element("document.version.2", in: app).exists, "the page has one version")
        XCTAssertTrue(element("document.version.1", in: app).label.contains("交付"))
    }

    // MARK: The screen

    /// Opens the 版本 list.
    @MainActor
    private func openVersions(in app: XCUIApplication) {
        let button = element("document.versions", in: app)
        XCTAssertTrue(button.waitForExistence(timeout: patience), "no 版本 button\n\(app.debugDescription)")
        XCTAssertTrue(wait(timeout: patience) { button.isEnabled }, "the 版本 button never enabled: the document's detail did not load")
        button.tap()
        XCTAssertTrue(element("document.version.1", in: app).waitForExistence(timeout: patience), "the 版本 list did not open\n\(app.debugDescription)")
    }

    /// The marks beside blocks that changed.
    @MainActor
    private func markedBlocks(in app: XCUIApplication) -> [XCUIElement] {
        app.descendants(matching: .any).matching(identifier: "markdown.changed").allElementsBoundByIndex
    }

    /// The row of the document with this title.
    @MainActor
    private func documentRow(titled title: String, in app: XCUIApplication) throws -> XCUIElement {
        let row = app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier BEGINSWITH 'document.row.' AND label CONTAINS %@", title)).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: patience), "the 文档 tab does not list \(title)\n\(app.debugDescription)")
        return row
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
