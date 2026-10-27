import XCTest

/// Pairs the app with a running `node scripts/app-dev.ts --seed-ideas` and works the 想法 tab: the badge of unseen ideas,
/// 讨论, accepting the weekly idea as it is and the one-off idea with 立即 after editing its brief, and rejecting the daily
/// idea. The pairing comes from the environment variable `ALFRED_PAIRING` (pass `TEST_RUNNER_ALFRED_PAIRING` to
/// xcodebuild); without it the tests skip themselves.
///
/// The tests use up the seeded ideas, so they need a fresh stack (new state and workspace directories), and they run in
/// the order of their names: the badge is checked first, while all three ideas are open. A test that finds its idea
/// already closed fails and says so. Nothing taps 现在想想, which would run the model. The accepted one-off task is ended
/// at once, so it does not run.
///
/// When `ALFRED_SHOTS` names a directory (pass `TEST_RUNNER_ALFRED_SHOTS`), the tests save screenshots of the screens
/// they pass through there.
final class IdeasUITests: XCTestCase {
    private let patience: TimeInterval = 30

    /// Something a quiet search did not find.
    private struct NotFound: Error {}

    // The seeded ideas, by title (see SEED_IDEAS in scripts/app-dev.ts).
    private let onceTitle = "对比三家 VPS 的带宽配额"
    private let weeklyTitle = "每周追踪 VPS 价格变化"
    private let dailyTitle = "每天检查供应商状态页"
    private let rejectedTitle = "把报告译成英文"
    private let weeklyBrief = "每周一看一次三家供应商的定价页，只报告和上周相比的变化。"
    private let note = "写两行关于咖啡的笔记。不要上网搜索，也不要用任何工具，直接回复这两行笔记。"

    @MainActor
    func test1TheBadgeCountsTheOpenIdeasUntilTheTabIsOpened() throws {
        let app = try launchPaired()
        let tab = app.tabBars.buttons["想法"]
        XCTAssertTrue(tab.waitForExistence(timeout: patience), "no 想法 tab\n\(app.debugDescription)")

        XCTAssertTrue(
            wait(timeout: patience) { badge(of: tab) == "3" },
            "the badge should count the three seeded ideas, but it shows \(badge(of: tab) ?? "nothing"): is the stack fresh?\n\(app.debugDescription)"
        )

        snapshot("1a-badge")
        tab.tap()
        _ = try openCard(titled: weeklyTitle, in: app)
        XCTAssertTrue(wait(timeout: patience) { badge(of: tab) == nil }, "the badge stayed after the tab was opened: \(badge(of: tab) ?? "")")
        snapshot("1b-ideas")

        // Once seen, an idea stays seen when the tab is left.
        openTab("对话", in: app)
        XCTAssertNil(badge(of: tab), "the badge came back after the tab was left")
    }

    @MainActor
    func test2DiscussPutsTheIdeaIntoTheComposer() throws {
        let app = try launchPaired()
        openTab("想法", in: app)

        // An empty composer takes the title and the brief.
        let weekly = try openCard(titled: weeklyTitle, in: app)
        tapButton("idea.discuss.", of: weekly, in: app)
        XCTAssertTrue(app.tabBars.buttons["对话"].isSelected, "讨论 did not show the chat")
        let composer = element("composer", in: app)
        XCTAssertTrue(composer.waitForExistence(timeout: patience))
        let first = "关于想法「\(weeklyTitle)」：\n\(weeklyBrief)"
        XCTAssertEqual(composer.value as? String, first, "the composer does not hold the idea")
        XCTAssertFalse(element("message.pending", in: app).exists, "讨论 sent something")
        snapshot("2-discuss")

        // A composer with text keeps it; the idea follows after a blank line.
        openTab("想法", in: app)
        let daily = try openCard(titled: dailyTitle, in: app)
        tapButton("idea.discuss.", of: daily, in: app)
        XCTAssertTrue(app.tabBars.buttons["对话"].isSelected, "讨论 did not show the chat")
        let both = try XCTUnwrap(element("composer", in: app).value as? String)
        XCTAssertTrue(both.hasPrefix(first + "\n\n关于想法「\(dailyTitle)」：\n"), "the composer lost what was in it, or the blank line: \(both)")
        XCTAssertFalse(element("message.pending", in: app).exists, "讨论 sent something")
    }

    @MainActor
    func test3TheWeeklyIdeaIsAcceptedUnchangedAndItsTaskIsEnded() throws {
        let app = try launchPaired()
        openTab("想法", in: app)
        let weekly = try openCard(titled: weeklyTitle, in: app)

        // The form shows the idea: its schedule fills the fields, and 立即 is not among the kinds.
        tapButton("idea.accept.", of: weekly, in: app)
        let title = element("task.form.title", in: app)
        XCTAssertTrue(title.waitForExistence(timeout: patience), "the accept form did not open\n\(app.debugDescription)")
        XCTAssertEqual(title.value as? String, weeklyTitle)
        XCTAssertTrue(app.navigationBars["采纳想法"].exists, "the form does not say it accepts an idea\n\(app.debugDescription)")
        XCTAssertEqual((element("task.form.brief", in: app).value as? String), weeklyBrief)
        XCTAssertTrue(app.buttons["每周"].isSelected, "a weekly idea starts on 每周\n\(app.debugDescription)")
        XCTAssertFalse(app.buttons["立即"].exists, "a recurring idea does not offer 立即")
        XCTAssertTrue(element("task.form.day.1", in: app).isSelected, "the idea's Monday is not selected")
        XCTAssertFalse(element("task.form.day.2", in: app).isSelected)
        XCTAssertEqual(element("task.form.budget", in: app).value as? String, "2", "the cap defaults to $2")
        snapshot("3a-accept-weekly")

        // Accepting it unchanged closes the form and opens the task in 任务.
        element("task.form.save", in: app).tap()
        XCTAssertTrue(element("task.brief", in: app).waitForExistence(timeout: patience), "the task's detail did not open\n\(app.debugDescription)")
        XCTAssertTrue(app.tabBars.buttons["任务"].isSelected, "the 任务 tab is not on screen")
        XCTAssertTrue(element("task.form.save", in: app).waitForNonExistence(timeout: patience), "the form stayed open")
        XCTAssertEqual(element("task.brief", in: app).label, weeklyBrief)
        XCTAssertTrue(hasLabel(startingWith: "计划, 每周一 09:00", in: app), "the detail does not show the idea's schedule\n\(app.debugDescription)")
        XCTAssertTrue(app.staticTexts["来源, 想法"].exists, "the task's origin is not 想法\n\(app.debugDescription)")
        XCTAssertTrue(app.staticTexts["单次上限, $2.00"].exists)
        XCTAssertEqual(element("task.status", in: app).label, "已启用")
        snapshot("3b-weekly-task")

        // End it.
        endTask(in: app)
        XCTAssertTrue(wait(timeout: patience) { element("task.status", in: app).label == "已结束" }, "the task did not show as 已结束\n\(app.debugDescription)")

        // The idea is in 历史, and a tap opens its task in 任务.
        app.navigationBars.buttons["任务"].tap()
        openTab("想法", in: app)
        XCTAssertTrue(wait(timeout: patience) { !cardExists(titled: weeklyTitle, in: app) }, "the accepted idea is still open")
        let row = try historyRow(titled: weeklyTitle, in: app)
        XCTAssertTrue(row.label.contains("已采纳"), "the history does not say the idea was accepted: \(row.label)")
        row.tap()
        XCTAssertTrue(element("task.status", in: app).waitForExistence(timeout: patience), "the accepted idea did not open its task\n\(app.debugDescription)")
        XCTAssertTrue(app.tabBars.buttons["任务"].isSelected, "the 任务 tab is not on screen")
        XCTAssertEqual(element("task.status", in: app).label, "已结束")
        XCTAssertEqual(element("task.brief", in: app).label, weeklyBrief)
    }

    @MainActor
    func test4TheOneOffIdeaIsAcceptedNowAfterEditingItsBrief() throws {
        let app = try launchPaired()
        openTab("想法", in: app)
        let once = try openCard(titled: onceTitle, in: app)
        XCTAssertTrue(once.staticTexts["一次性"].exists, "the card does not say the idea is one-off\n\(app.debugDescription)")
        XCTAssertTrue(once.staticTexts["sonnet · 约 $0.35"].exists, "the card does not show the model and the estimate\n\(app.debugDescription)")

        // 立即 leads the kinds and is the one chosen; the ordinary kinds stay available.
        tapButton("idea.accept.", of: once, in: app)
        XCTAssertTrue(element("task.form.title", in: app).waitForExistence(timeout: patience), "the accept form did not open\n\(app.debugDescription)")
        let now = app.buttons["立即"]
        XCTAssertTrue(now.exists && now.isSelected, "a one-off idea starts on 立即\n\(app.debugDescription)")
        for kind in ["每天", "每周", "每隔", "一次"] {
            XCTAssertTrue(app.buttons[kind].exists, "\(kind) is not among the kinds\n\(app.debugDescription)")
        }
        XCTAssertLessThan(now.frame.minX, app.buttons["每天"].frame.minX, "立即 does not lead the kinds")
        snapshot("4a-accept-once")

        // Edit the brief to a two-line note, and take haiku with a cap of $0.30.
        let brief = element("task.form.brief", in: app)
        replaceText(in: brief, with: note, tappingAt: CGVector(dx: 0.9, dy: 0.9))
        app.buttons["haiku"].tap()
        replaceText(in: element("task.form.budget", in: app), with: "0.3")
        XCTAssertTrue(now.isSelected, "the kind changed while the form was edited")
        snapshot("4b-edited")
        element("task.form.save", in: app).tap()

        // The task is in 任务 with what was typed, and runs once, a minute from now.
        XCTAssertTrue(element("task.brief", in: app).waitForExistence(timeout: patience), "the task's detail did not open\n\(app.debugDescription)")
        XCTAssertTrue(app.tabBars.buttons["任务"].isSelected, "the 任务 tab is not on screen")
        XCTAssertEqual(element("task.brief", in: app).label, note)
        XCTAssertTrue(app.staticTexts["模型, haiku"].exists, "the detail does not show haiku\n\(app.debugDescription)")
        XCTAssertTrue(app.staticTexts["单次上限, $0.30"].exists, "the detail does not show the cap\n\(app.debugDescription)")
        XCTAssertTrue(app.staticTexts["来源, 想法"].exists, "the task's origin is not 想法\n\(app.debugDescription)")
        XCTAssertTrue(
            hasLabel(matching: "label BEGINSWITH '计划, ' AND label ENDSWITH ' 一次'", in: app),
            "the detail does not show a one-time run\n\(app.debugDescription)"
        )
        XCTAssertEqual(element("task.status", in: app).label, "已启用")
        snapshot("4c-once-task")

        // End it before it runs: the test needs no model reply.
        endTask(in: app)
        XCTAssertTrue(wait(timeout: patience) { element("task.status", in: app).label == "已结束" }, "the task did not show as 已结束\n\(app.debugDescription)")
    }

    @MainActor
    func test5TheDailyIdeaIsRejectedAsNotNowAndFoundInHistory() throws {
        let app = try launchPaired()
        openTab("想法", in: app)
        let daily = try openCard(titled: dailyTitle, in: app)

        // The dialog lists the five reasons and 补充一句…, which opens a sheet: 不要 waits for a reason.
        tapButton("idea.reject.", of: daily, in: app)
        for reason in ["不感兴趣", "已经在做了", "时机不对", "太贵", "方向不对", "补充一句…"] {
            XCTAssertTrue(app.sheets.buttons[reason].waitForExistence(timeout: patience), "the dialog does not offer \(reason)\n\(app.debugDescription)")
        }
        snapshot("5a-reasons")
        app.sheets.buttons["补充一句…"].tap()
        let send = element("idea.reject.send", in: app)
        XCTAssertTrue(send.waitForExistence(timeout: patience), "the sheet did not open\n\(app.debugDescription)")
        XCTAssertFalse(send.isEnabled, "不要 can be sent without a reason")
        element("idea.reject.reason.too-expensive", in: app).tap()
        XCTAssertTrue(send.isEnabled, "不要 cannot be sent after a reason is picked")
        let noteField = element("idea.reject.note", in: app)
        noteField.tap()
        noteField.typeText("先放着")
        snapshot("5b-note-sheet")
        app.buttons["取消"].tap()
        XCTAssertTrue(send.waitForNonExistence(timeout: patience), "the sheet stayed open")
        XCTAssertTrue(cardExists(titled: dailyTitle, in: app), "cancelling the sheet closed the idea")

        // Tapping a reason in the dialog rejects at once.
        tapButton("idea.reject.", of: daily, in: app)
        let reason = app.sheets.buttons["时机不对"]
        XCTAssertTrue(reason.waitForExistence(timeout: patience), "the dialog did not open\n\(app.debugDescription)")
        reason.tap()
        XCTAssertTrue(wait(timeout: patience) { !cardExists(titled: dailyTitle, in: app) }, "the rejected idea is still open\n\(app.debugDescription)")

        // 历史 holds it with the reason, and the seeded rejection with its reason and its note.
        let row = try historyRow(titled: dailyTitle, in: app)
        XCTAssertTrue(row.label.contains("时机不对"), "the history does not give the reason: \(row.label)")
        let seeded = try historyRow(titled: rejectedTitle, in: app)
        XCTAssertTrue(seeded.label.contains("时机不对"), "the seeded rejection does not give its reason: \(seeded.label)")
        XCTAssertTrue(seeded.label.contains("等这周的报告定稿再说。"), "the seeded rejection does not give its note: \(seeded.label)")
        snapshot("5c-history")
    }

    @MainActor
    func test6WithNoOpenIdeasLeftTheTabOffersToThinkNow() throws {
        let app = try launchPaired()
        openTab("想法", in: app)
        XCTAssertTrue(element("ideas.generate", in: app).waitForExistence(timeout: patience), "the toolbar has no 现在想想\n\(app.debugDescription)")
        try XCTSkipIf(
            wait(timeout: 3) { app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'idea.card.'")).count > 0 },
            "ideas are still open: this check needs the tests before it to have closed them"
        )
        XCTAssertTrue(element("ideas.empty.generate", in: app).waitForExistence(timeout: patience), "the empty state does not offer 现在想想\n\(app.debugDescription)")
        snapshot("6-empty")
    }

    // MARK: The tab

    /// The card of the open idea with this title, found by scrolling. When it is not there, the failure says whether the
    /// idea is closed already.
    @MainActor
    private func openCard(titled title: String, in app: XCUIApplication) throws -> XCUIElement {
        let card = card(titled: title, in: app)
        // The list builds a row only once it is scrolled to.
        if !find(card, in: app, timeout: patience) {
            let closed = hasHistoryRow(titled: title, in: app)
            XCTFail(
                closed
                    ? "the idea \(title) is already closed (it is in 历史): start a fresh `node scripts/app-dev.ts --seed-ideas` stack"
                    : "the 想法 tab has no open idea \(title)\n\(app.debugDescription)"
            )
            throw NotFound()
        }
        return card
    }

    @MainActor
    private func card(titled title: String, in app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier BEGINSWITH 'idea.card.' AND label == %@", title)).firstMatch
    }

    @MainActor
    private func cardExists(titled title: String, in app: XCUIApplication) -> Bool {
        card(titled: title, in: app).exists
    }

    /// Taps the button of a card whose identifier starts with `prefix` and ends with the card's idea id.
    @MainActor
    private func tapButton(_ prefix: String, of card: XCUIElement, in app: XCUIApplication) {
        let id = String(card.identifier.dropFirst("idea.card.".count))
        let button = element(prefix + id, in: app)
        XCTAssertTrue(find(button, in: app, timeout: patience), "no \(prefix) button on the card\n\(app.debugDescription)")
        scrollBetweenBars(button, in: app)
        button.tap()
    }

    @MainActor
    private func hasHistoryRow(titled title: String, in app: XCUIApplication) -> Bool {
        (try? historyRow(titled: title, in: app, quietly: true)) != nil
    }

    /// The row in 历史 of the idea with this title: the section is opened if it is closed.
    @MainActor
    private func historyRow(titled title: String, in app: XCUIApplication, quietly: Bool = false) throws -> XCUIElement {
        let toggle = element("ideas.history", in: app)
        guard find(toggle, in: app, timeout: quietly ? 3 : patience) else {
            if !quietly { XCTFail("the 想法 tab has no 历史\n\(app.debugDescription)") }
            throw NotFound()
        }
        let row = app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier BEGINSWITH 'idea.history.' AND label CONTAINS %@", title)).firstMatch
        if !row.exists, toggle.value as? String != "已展开" {
            scrollBetweenBars(toggle, in: app)
            toggle.tap()
        }
        guard find(row, in: app, timeout: quietly ? 3 : patience) else {
            if !quietly { XCTFail("the 历史 does not list \(title)\n\(app.debugDescription)") }
            throw NotFound()
        }
        return row
    }

    // MARK: Waiting and scrolling

    /// Whether `target` turns up in the list within `timeout`, scrolling a step towards it at each look: down first, and
    /// back up when the end is reached. The list builds a row only once it is scrolled to.
    @MainActor
    private func find(_ target: XCUIElement, in app: XCUIApplication, timeout: TimeInterval) -> Bool {
        var steps = 0
        return wait(timeout: timeout) {
            if target.exists { return true }
            steps += 1
            if steps <= 6 { app.swipeUp() } else { app.swipeDown() }
            return target.exists
        }
    }

    /// The badge of a tab bar button, as its number: the system gives it as the button's value, `3 items`. `nil` when
    /// the button has none.
    @MainActor
    private func badge(of tab: XCUIElement) -> String? {
        guard let value = tab.value as? String else { return nil }
        let digits = value.prefix { $0.isNumber }
        return digits.isEmpty ? nil : String(digits)
    }

    @MainActor
    private func hasLabel(startingWith prefix: String, in app: XCUIApplication) -> Bool {
        hasLabel(matching: "label BEGINSWITH %@", argument: prefix, in: app)
    }

    @MainActor
    private func hasLabel(matching format: String, argument: String? = nil, in app: XCUIApplication) -> Bool {
        let predicate = argument.map { NSPredicate(format: format, $0) } ?? NSPredicate(format: format)
        return app.staticTexts.matching(predicate).firstMatch.exists
    }

    /// Taps 结束 and confirms.
    @MainActor
    private func endTask(in app: XCUIApplication) {
        let end = element("task.end", in: app)
        scrollBetweenBars(end, in: app)
        end.tap()
        // The confirmation is a sheet with a button of the same name as the one that opened it.
        let confirm = app.sheets.buttons["结束"]
        XCTAssertTrue(confirm.waitForExistence(timeout: patience), "no confirmation\n\(app.debugDescription)")
        confirm.tap()
    }

    /// Scrolls the list until `target` lies between the navigation bar and the tab bar, and waits for the list to stop.
    /// The bars are glass, so XCUITest counts a row under one as hittable, but a tap there lands on the bar.
    @MainActor
    private func scrollBetweenBars(_ target: XCUIElement, in app: XCUIApplication) {
        XCTAssertTrue(target.waitForExistence(timeout: patience), "the element to scroll to is not there\n\(app.debugDescription)")
        let top = app.navigationBars.firstMatch.frame.maxY
        let bottom = app.tabBars.firstMatch.frame.minY
        var previous: CGRect?
        XCTAssertTrue(wait(timeout: patience) {
            let frame = target.frame
            defer { previous = frame }
            if frame.minY < top {
                app.swipeDown()
                return false
            }
            if frame.maxY > bottom {
                app.swipeUp()
                return false
            }
            return frame == previous
        }, "the element did not come to rest between the bars\n\(app.debugDescription)")
    }

    /// Puts `text` in a field in place of what it holds. The tap lands past the end of the text, so the cursor does too.
    @MainActor
    private func replaceText(in field: XCUIElement, with text: String, tappingAt offset: CGVector = CGVector(dx: 0.5, dy: 0.5)) {
        field.coordinate(withNormalizedOffset: offset).tap()
        let held = (field.value as? String)?.count ?? 0
        field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: held) + text)
    }

    // MARK: Screenshots

    /// Saves a screenshot of the app when `ALFRED_SHOTS` names a directory.
    @MainActor
    private func snapshot(_ name: String) {
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
            throw XCTSkip("ALFRED_PAIRING is not set: start scripts/app-dev.ts --seed-ideas and pass its pairing to run this test")
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

    /// Opens a tab. The composer keeps the keyboard after a send, and the keyboard covers the tab bar, so it goes first.
    @MainActor
    private func openTab(_ name: String, in app: XCUIApplication) {
        if app.keyboards.count > 0 {
            let top = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.25))
            let bottom = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.98))
            top.press(forDuration: 0.1, thenDragTo: bottom)
            XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: patience), "the keyboard stayed up")
        }
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
