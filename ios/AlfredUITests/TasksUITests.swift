import XCTest

/// Pairs the app with a running `scripts/app-dev.ts` and works the 任务 tab: it creates a task in the form (haiku, a
/// cap of $0.30, daily), opens it, pauses and resumes it, runs it now and waits for the run to finish, finds the task's
/// name over the message the run delivered in the chat, and ends it. The pairing comes from the environment variable
/// `ALFRED_PAIRING` (pass `TEST_RUNNER_ALFRED_PAIRING` to xcodebuild); without it the tests skip themselves. The first test
/// runs the model once, on haiku under a cap of $0.30; the second runs nothing.
final class TasksUITests: XCTestCase {
    private let patience: TimeInterval = 30
    private let modelPatience: TimeInterval = 120

    @MainActor
    func testATaskIsCreatedPausedResumedRunAndEnded() throws {
        let app = try launchPaired()
        // Tasks stay on the stack, so each run looks for the task it made.
        let title = "UI 测试任务 \(Int(Date().timeIntervalSince1970) % 100_000)"

        // Create it: a daily task on haiku, capped at $0.30.
        openTab("任务", in: app)
        createTask(
            titled: title,
            brief: "写两行关于咖啡的笔记。不要上网搜索，也不要用任何工具，直接回复这两行笔记。",
            budget: "0.3",
            in: app
        )

        // It is in the list, and its detail shows what was typed.
        let row = try taskRow(titled: title, in: app)
        let taskId = String(row.identifier.dropFirst("task.row.".count))
        row.tap()
        XCTAssertTrue(element("task.brief", in: app).waitForExistence(timeout: patience), "the task's detail did not open\n\(app.debugDescription)")
        XCTAssertTrue(element("task.brief", in: app).label.contains("两行关于咖啡的笔记"), "the brief is not shown in full")
        XCTAssertTrue(app.staticTexts["模型, haiku"].exists, "the detail does not show the model\n\(app.debugDescription)")
        XCTAssertTrue(app.staticTexts["单次上限, $0.30"].exists, "the detail does not show the cap\n\(app.debugDescription)")
        XCTAssertTrue(app.staticTexts["计划, 每天 08:00"].exists, "the detail does not show the schedule\n\(app.debugDescription)")
        XCTAssertEqual(element("task.status", in: app).label, "已启用")

        // Pause it: the detail and the list say so. Resume it.
        element("task.pause", in: app).tap()
        XCTAssertTrue(wait(timeout: patience) { element("task.status", in: app).label == "已暂停" }, "the task did not show as 已暂停\n\(app.debugDescription)")
        XCTAssertTrue(element("task.resume", in: app).exists, "a paused task offers 恢复")
        goBack(in: app)
        XCTAssertTrue(wait(timeout: patience) { row.label.contains("已暂停") }, "the list does not mark the task 已暂停: \(row.label)")
        row.tap()
        element("task.resume", in: app).tap()
        XCTAssertTrue(wait(timeout: patience) { element("task.status", in: app).label == "已启用" }, "the task did not show as running again\n\(app.debugDescription)")

        // Run it now: the run shows among the task's runs and finishes.
        element("task.run", in: app).tap()
        // The runs are the last section, below the screen: the list builds a row only once it is scrolled to.
        let finished = app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier BEGINSWITH 'task.run.' AND label CONTAINS '完成'")).firstMatch
        XCTAssertTrue(wait(timeout: modelPatience) {
            if !finished.exists { app.swipeUp() }
            return finished.exists
        }, "no run of the task finished\n\(app.debugDescription)")
        XCTAssertTrue(finished.label.contains("haiku"), "the run did not use haiku: \(finished.label)")

        // The chat shows the task's name over the message the run delivered.
        openTab("对话", in: app)
        let label = app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier BEGINSWITH 'message.task.' AND label == %@", title)).firstMatch
        XCTAssertTrue(label.waitForExistence(timeout: patience), "no message in the chat is labelled with the task\n\(app.debugDescription)")

        // End it: it leaves the list and is found under 已结束. The tab is still on the task's detail.
        openTab("任务", in: app)
        XCTAssertTrue(wait(timeout: patience) {
            if !element("task.end", in: app).exists { app.swipeDown() }
            return element("task.end", in: app).exists
        }, "the tab did not keep the task's detail\n\(app.debugDescription)")
        endTask(in: app)
        XCTAssertTrue(wait(timeout: patience) { element("task.status", in: app).label == "已结束" }, "the task did not show as 已结束\n\(app.debugDescription)")
        XCTAssertFalse(element("task.end", in: app).exists, "an ended task cannot be ended again")
        goBack(in: app)
        XCTAssertTrue(wait(timeout: patience) { !element("task.row.\(taskId)", in: app).exists }, "the ended task is still among the open ones")
        element("tasks.ended", in: app).tap()
        XCTAssertTrue(element("task.row.\(taskId)", in: app).waitForExistence(timeout: patience), "the ended task is not under 已结束\n\(app.debugDescription)")
    }

    @MainActor
    func testTheFormChecksBeforeSendingAndAnEditSendsWhatChanged() throws {
        let app = try launchPaired()
        let title = "UI 表单任务 \(Int(Date().timeIntervalSince1970) % 100_000)"

        // A blank form is refused before anything is sent, and stays open.
        openTab("任务", in: app)
        element("tasks.add", in: app).tap()
        element("task.form.save", in: app).tap()
        let problems = element("task.form.error", in: app)
        XCTAssertTrue(problems.waitForExistence(timeout: patience), "a blank form was not refused\n\(app.debugDescription)")
        XCTAssertTrue(app.staticTexts["请填写标题"].exists && app.staticTexts["请填写任务说明"].exists, "the problems are not named\n\(app.debugDescription)")

        // Fill it in on the same form: what is typed is kept.
        let titleField = element("task.form.title", in: app)
        titleField.tap()
        titleField.typeText(title)
        let brief = element("task.form.brief", in: app)
        brief.tap()
        brief.typeText("不会运行的任务")
        element("task.form.save", in: app).tap()
        let row = try taskRow(titled: title, in: app)
        row.tap()
        XCTAssertTrue(app.staticTexts["单次上限, $2.00"].waitForExistence(timeout: patience), "a new task has the default cap\n\(app.debugDescription)")

        // Edit only the cap.
        element("task.edit", in: app).tap()
        let budget = element("task.form.budget", in: app)
        XCTAssertTrue(budget.waitForExistence(timeout: patience), "the edit form did not open\n\(app.debugDescription)")
        XCTAssertEqual(element("task.form.title", in: app).value as? String, title, "the edit form does not show the task")
        replaceText(in: budget, with: "0.5")
        element("task.form.save", in: app).tap()
        XCTAssertTrue(app.staticTexts["单次上限, $0.50"].waitForExistence(timeout: patience), "the new cap is not shown\n\(app.debugDescription)")
        XCTAssertTrue(app.staticTexts["单次上限, $2.00"].waitForNonExistence(timeout: patience), "the old cap is still shown")

        // This task has no use after the test.
        endTask(in: app)
        XCTAssertTrue(wait(timeout: patience) { element("task.status", in: app).label == "已结束" }, "the task did not show as 已结束\n\(app.debugDescription)")
    }

    // MARK: The form

    /// Opens the form from the + button, fills it for a daily task on haiku, and saves.
    @MainActor
    private func createTask(titled title: String, brief: String, budget: String, in app: XCUIApplication) {
        element("tasks.add", in: app).tap()
        let titleField = element("task.form.title", in: app)
        XCTAssertTrue(titleField.waitForExistence(timeout: patience), "the form did not open\n\(app.debugDescription)")
        titleField.tap()
        titleField.typeText(title)
        let briefField = element("task.form.brief", in: app)
        briefField.tap()
        briefField.typeText(brief)
        app.buttons["haiku"].tap()
        replaceText(in: element("task.form.budget", in: app), with: budget)
        element("task.form.save", in: app).tap()
        XCTAssertTrue(element("task.form.save", in: app).waitForNonExistence(timeout: patience), "the form did not close\n\(app.debugDescription)")
    }

    // MARK: The tab

    /// The row of the task with this title.
    @MainActor
    private func taskRow(titled title: String, in app: XCUIApplication) throws -> XCUIElement {
        let row = app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier BEGINSWITH 'task.row.' AND label CONTAINS %@", title)).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: patience), "the 任务 tab does not list \(title)\n\(app.debugDescription)")
        return row
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
    /// The bars are glass, so XCUITest counts a row under one as hittable, but a tap there lands on the bar: on the
    /// navigation bar it scrolls the list to the top and presses nothing.
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
    private func replaceText(in field: XCUIElement, with text: String) {
        field.tap()
        let held = (field.value as? String)?.count ?? 0
        field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: held) + text)
    }

    @MainActor
    private func goBack(in app: XCUIApplication) {
        let back = app.navigationBars.buttons["任务"]
        XCTAssertTrue(back.waitForExistence(timeout: patience), "no back button\n\(app.debugDescription)")
        back.tap()
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
