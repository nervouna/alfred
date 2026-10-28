import XCTest

/// Pairs the app with a running `node scripts/app-dev.ts` and works the 设置 tab: it is the fifth tab and shows every row;
/// a change of the model and of the daily cap is shown at once, again after leaving the tab and after pulling to refresh,
/// and after the app is started again, and 全部恢复默认 returns them; a model changed in the tab shows in the chat's
/// `/status` and one changed by `/model` in the chat shows in the tab; 取消配对 asks first and, confirmed, returns to the
/// pairing screen. The pairing comes from the environment variable `ALFRED_PAIRING` (pass `TEST_RUNNER_ALFRED_PAIRING` to
/// xcodebuild); without it the tests skip themselves.
///
/// None of the tests runs the model: `/status` and `/model` are answered by Alfred itself, and the daily generation of
/// ideas is never turned on. The tests change the stack's model and leave it on haiku, which is what `app-dev` starts
/// with, so the tests that do run the model stay cheap.
///
/// When `ALFRED_SHOTS` names a directory (pass `TEST_RUNNER_ALFRED_SHOTS`), the tests save screenshots of the tab there.
final class SettingsUITests: XCTestCase {
    private let patience: TimeInterval = 30

    /// What the plain `app-dev` stack starts the chat's model on, and what the tests leave it on.
    private let stackModel = "Haiku"

    @MainActor
    func test1TheTabIsTheFifthAndShowsEveryRow() throws {
        let app = try launchPaired()
        allowNotifications(waiting: 5)

        let labels = app.tabBars.buttons.allElementsBoundByIndex.map(\.label)
        XCTAssertEqual(labels, ["对话", "任务", "文档", "想法", "设置"], "the tabs are not the five in order\n\(app.debugDescription)")
        openTab("设置", in: app)
        XCTAssertTrue(app.tabBars.buttons["设置"].isSelected, "the 设置 tab did not open")
        XCTAssertTrue(app.navigationBars["设置"].waitForExistence(timeout: patience), "the tab is not titled 设置\n\(app.debugDescription)")
        XCTAssertTrue(element("settings.model", in: app).waitForExistence(timeout: patience), "the settings did not load\n\(app.debugDescription)")
        snapshot("1a-top")

        // Every row, found by scrolling: the list builds a row only once it is scrolled to.
        for id in [
            "settings.model", "settings.dailyBudget", "settings.runBudget", "settings.spentToday", "settings.sessionIdleHours",
            "settings.compactTokens", "settings.memoryScanMinutes", "settings.memoryScanBudget", "settings.ideasEnabled",
            "settings.notifications", "settings.notifications.open", "settings.server", "settings.device", "settings.unpair",
            "settings.version",
        ] {
            XCTAssertTrue(find(element(id, in: app), in: app, timeout: patience), "no \(id) row\n\(app.debugDescription)")
        }
        XCTAssertTrue(element("settings.menu", in: app).exists, "no menu in the bar")

        // What the plain stack holds: the daily generation of ideas is off, so there is no time row, and the values are
        // Alfred's defaults.
        XCTAssertEqual(try reading("settings.ideasEnabled", in: app).value, "0", "the daily generation should be off on this stack")
        XCTAssertFalse(element("settings.ideasAt", in: app).exists, "a time row shows while the generation is off")
        let expected = [
            ("settings.runBudget", "$10.00"), ("settings.compactTokens", "100k"), ("settings.sessionIdleHours", "4 小时"),
            ("settings.memoryScanMinutes", "1 小时"), ("settings.memoryScanBudget", "$0.10"),
        ]
        for (id, shown) in expected {
            let row = try reading(id, in: app).text
            XCTAssertTrue(row.contains(shown), "\(id) does not show \(shown): \(row)")
        }

        // The notification state, the pairing, the version.
        _ = try reading("settings.notifications", in: app)
        // The row says 已开启 once the owner has answered the system's question: until then the system does not tell the app
        // anything, so the test answers it whenever it turns up.
        let allowed = wait(timeout: patience) {
            allowNotifications()
            return element("settings.notifications", in: app).label.contains("已开启")
        }
        snapshot("1c-notifications")
        XCTAssertTrue(
            allowed,
            "the notification state is not 已开启 after Allow: \(element("settings.notifications", in: app).label)\n\(XCUIApplication(bundleIdentifier: "com.apple.springboard").alerts.debugDescription)"
        )
        let server = try reading("settings.server", in: app).text
        XCTAssertTrue(server.contains("127.0.0.1"), "the server's host is not shown: \(server)")
        let device = try reading("settings.device", in: app).text
        XCTAssertGreaterThan(device.count, "设备, ".count, "the device id is not shown: \(device)")
        let version = try reading("settings.version", in: app).text
        XCTAssertTrue(version.hasPrefix("版本, "), "the version is not shown: \(version)")
        snapshot("1b-bottom")
    }

    @MainActor
    func test2AChangeIsShownAtOnceAndKeptAndResettingAllReturnsIt() throws {
        let app = try launchPaired()
        openTab("设置", in: app)
        let daily = element("settings.dailyBudget", in: app)
        XCTAssertTrue(daily.waitForExistence(timeout: patience), "the settings did not load\n\(app.debugDescription)")

        // Start from Alfred's defaults, whatever an earlier run left on the stack: `before` is the default cap.
        resetAllSettings(in: app)
        XCTAssertTrue(wait(timeout: patience) { text(of: element("settings.model", in: app)).contains("Sonnet") }, "the model did not return to Sonnet")
        let before = try XCTUnwrap(dollars(daily), "the daily cap shows no amount: \(text(of: daily))")
        XCTAssertLessThanOrEqual(before, 90, "this test raises the cap by $10, and the contract stops at $100")

        // The model and the daily cap change. The cap takes two taps, which are one save.
        choose("Opus", from: "settings.model", in: app)
        step("settings.dailyBudget", up: true, in: app)
        step("settings.dailyBudget", up: true, in: app)
        XCTAssertTrue(wait(timeout: patience) { dollars(daily) == before + 10 }, "the cap does not show \(before + 10): \(text(of: daily))\n\(app.debugDescription)")
        XCTAssertTrue(wait(timeout: patience) { text(of: element("settings.model", in: app)).contains("Opus") }, "the model does not show Opus")
        snapshot("2a-changed")

        // Leaving the tab and coming back shows them again.
        openTab("对话", in: app)
        openTab("设置", in: app)
        XCTAssertTrue(element("settings.dailyBudget", in: app).waitForExistence(timeout: patience), "the tab came back empty\n\(app.debugDescription)")
        XCTAssertEqual(dollars(element("settings.dailyBudget", in: app)), before + 10, "the cap is gone after leaving the tab")
        XCTAssertTrue(text(of: element("settings.model", in: app)).contains("Opus"), "the model is gone after leaving the tab")

        // So does pulling to refresh, once the save has reached Alfred.
        settle(seconds: 3)
        pullToRefresh(in: app)
        XCTAssertEqual(dollars(element("settings.dailyBudget", in: app)), before + 10, "the cap is gone after refreshing")
        XCTAssertTrue(text(of: element("settings.model", in: app)).contains("Opus"), "the model is gone after refreshing")

        // And the app started again reads them from Alfred, which kept them.
        app.terminate()
        app.launch()
        XCTAssertTrue(app.tabBars.buttons["设置"].waitForExistence(timeout: patience), "the app did not come back paired\n\(app.debugDescription)")
        openTab("设置", in: app)
        XCTAssertTrue(wait(timeout: patience) { dollars(element("settings.dailyBudget", in: app)) == before + 10 }, "Alfred did not keep the cap: \(text(of: element("settings.dailyBudget", in: app)))\n\(app.debugDescription)")
        XCTAssertTrue(text(of: element("settings.model", in: app)).contains("Opus"), "Alfred did not keep the model")

        // 全部恢复默认 asks first. Declining changes nothing.
        let resetAll = menuItem("全部恢复默认", id: "settings.resetAll", in: app)
        XCTAssertTrue(resetAll.isEnabled, "全部恢复默认 is off while settings are changed")
        tapWhenSettled(resetAll, in: app)
        let confirm = app.sheets.buttons["全部恢复默认"].firstMatch
        XCTAssertTrue(confirm.waitForExistence(timeout: patience), "no confirmation\n\(app.debugDescription)")
        dismissDialog(in: app)
        XCTAssertTrue(confirm.waitForNonExistence(timeout: patience), "the confirmation stayed")
        XCTAssertEqual(dollars(element("settings.dailyBudget", in: app)), before + 10, "declining reset something")

        // Confirming returns every setting to its default.
        tapWhenSettled(menuItem("全部恢复默认", id: "settings.resetAll", in: app), in: app)
        XCTAssertTrue(confirm.waitForExistence(timeout: patience), "no confirmation\n\(app.debugDescription)")
        tapWhenSettled(confirm, in: app)
        XCTAssertTrue(wait(timeout: patience) { dollars(element("settings.dailyBudget", in: app)) == before }, "the cap did not return to $\(before): \(text(of: element("settings.dailyBudget", in: app)))\n\(app.debugDescription)")
        XCTAssertTrue(wait(timeout: patience) { text(of: element("settings.model", in: app)).contains("Sonnet") }, "the model did not return to Sonnet")
        let disabled = menuItem("全部恢复默认", id: "settings.resetAll", in: app)
        XCTAssertTrue(wait(timeout: patience) { !disabled.isEnabled }, "全部恢复默认 stays on with every setting at its default")
        dismissMenu(in: app)
        snapshot("2b-reset")

        // The tests after this one run the model on haiku, as the stack started.
        choose(stackModel, from: "settings.model", in: app)
        XCTAssertTrue(wait(timeout: patience) { text(of: element("settings.model", in: app)).contains(self.stackModel) }, "the model is not back on \(stackModel)")
        settle(seconds: 2)
    }

    @MainActor
    func test3TheModelFollowsTheChatBothWays() throws {
        let app = try launchPaired()
        openTab("设置", in: app)
        XCTAssertTrue(element("settings.model", in: app).waitForExistence(timeout: patience), "the settings did not load\n\(app.debugDescription)")

        // A model chosen in the tab is the one /status names.
        choose("Opus", from: "settings.model", in: app)
        settle(seconds: 2)
        openTab("对话", in: app)
        var known = messageIds(in: app)
        send("/status", in: app)
        let status = newReply(known, containing: "模型：opus", in: app)
        XCTAssertTrue(status.waitForExistence(timeout: patience), "/status does not name opus\n\(app.debugDescription)")

        // A model chosen by /model in the chat shows in the tab, which did not have to be reloaded.
        known = messageIds(in: app)
        send("/model \(stackModel.lowercased())", in: app)
        XCTAssertTrue(newReply(known, containing: "已切换到 \(stackModel.lowercased())", in: app).waitForExistence(timeout: patience), "/model was not answered\n\(app.debugDescription)")
        openTab("设置", in: app)
        XCTAssertTrue(
            wait(timeout: patience) { text(of: element("settings.model", in: app)).contains(self.stackModel) },
            "the tab does not show \(stackModel): \(text(of: element("settings.model", in: app)))\n\(app.debugDescription)"
        )
        snapshot("3-model-from-chat")
    }

    @MainActor
    func test4UnpairingAsksFirstAndReturnsToThePairingScreen() throws {
        let app = try launchPaired()
        openTab("设置", in: app)
        let unpair = element("settings.unpair", in: app)
        XCTAssertTrue(find(unpair, in: app, timeout: patience), "no 取消配对 row\n\(app.debugDescription)")
        scrollBetweenBars(unpair, in: app)

        // It asks. Declining leaves the app paired.
        tapWhenSettled(unpair, in: app)
        let confirm = app.sheets.buttons["取消配对"].firstMatch
        XCTAssertTrue(confirm.waitForExistence(timeout: patience), "no confirmation\n\(app.debugDescription)")
        snapshot("4-unpair-dialog")
        dismissDialog(in: app)
        XCTAssertTrue(confirm.waitForNonExistence(timeout: patience), "the confirmation stayed")
        XCTAssertFalse(app.buttons["粘贴配对信息"].exists, "the app unpaired without being asked")
        XCTAssertTrue(app.tabBars.buttons["设置"].exists)

        // Confirming returns to the pairing screen.
        scrollBetweenBars(unpair, in: app)
        tapWhenSettled(unpair, in: app)
        XCTAssertTrue(confirm.waitForExistence(timeout: patience), "no confirmation\n\(app.debugDescription)")
        tapWhenSettled(confirm, in: app)
        XCTAssertTrue(app.buttons["粘贴配对信息"].waitForExistence(timeout: patience), "the app did not return to pairing\n\(app.debugDescription)")
        XCTAssertFalse(app.tabBars.buttons["设置"].exists, "the tabs stayed after unpairing")
    }

    // MARK: Controls

    /// Picks `option` in the menu of the picker `id`.
    @MainActor
    private func choose(_ option: String, from id: String, in app: XCUIApplication) {
        let picker = element(id, in: app)
        scrollBetweenBars(picker, in: app)
        tapWhenSettled(picker, in: app)
        let item = app.buttons.matching(NSPredicate(format: "label == %@", option)).firstMatch
        XCTAssertTrue(item.waitForExistence(timeout: patience), "the picker \(id) has no \(option)\n\(app.debugDescription)")
        tapWhenSettled(item, in: app)
        XCTAssertTrue(item.waitForNonExistence(timeout: patience), "the menu of \(id) stayed open")
    }

    /// One tap on a stepper's plus or minus.
    @MainActor
    private func step(_ id: String, up: Bool, in app: XCUIApplication) {
        let stepper = element(id, in: app)
        scrollBetweenBars(stepper, in: app)
        let button = stepper.buttons[up ? "Increment" : "Decrement"]
        if button.exists {
            button.tap()
        } else if stepper.buttons.count >= 2 {
            stepper.buttons.element(boundBy: up ? 1 : 0).tap()
        } else {
            stepper.coordinate(withNormalizedOffset: CGVector(dx: up ? 0.94 : 0.82, dy: 0.5)).tap()
        }
    }

    /// A row scrolled between the bars, with what it says and its value. The list builds a row only once it is scrolled to,
    /// so a row read after others were is found again first.
    @MainActor
    private func reading(_ id: String, in app: XCUIApplication) throws -> (text: String, value: String?) {
        let row = element(id, in: app)
        scrollBetweenBars(row, in: app)
        return (text(of: row), row.value as? String)
    }

    /// What a row says: its label and its value.
    @MainActor
    private func text(of row: XCUIElement) -> String {
        [row.label, row.value as? String].compactMap { $0 }.joined(separator: " ")
    }

    /// The amount a cap row shows, in dollars.
    @MainActor
    private func dollars(_ row: XCUIElement) -> Double? {
        guard row.exists, let range = text(of: row).range(of: #"\$([0-9]+(\.[0-9]+)?)"#, options: .regularExpression) else { return nil }
        return Double(text(of: row)[range].dropFirst())
    }

    /// Closes a confirmation dialog without choosing. The dialog is a popover with no cancel button, so a tap beside it does.
    @MainActor
    private func dismissDialog(in app: XCUIApplication) {
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.08, dy: 0.2)).tap()
    }

    /// 全部恢复默认, confirmed. Nothing happens when every setting is at its default and the item is off.
    @MainActor
    private func resetAllSettings(in app: XCUIApplication) {
        let item = menuItem("全部恢复默认", id: "settings.resetAll", in: app)
        guard item.isEnabled else {
            dismissMenu(in: app)
            return
        }
        tapWhenSettled(item, in: app)
        let confirm = app.sheets.buttons["全部恢复默认"].firstMatch
        XCTAssertTrue(confirm.waitForExistence(timeout: patience), "no confirmation\n\(app.debugDescription)")
        tapWhenSettled(confirm, in: app)
        XCTAssertTrue(confirm.waitForNonExistence(timeout: patience), "the confirmation stayed")
    }

    /// Opens the menu in the navigation bar and returns one of its items: found by its identifier, or by its name.
    @MainActor
    private func menuItem(_ title: String, id: String, in app: XCUIApplication) -> XCUIElement {
        let menu = element("settings.menu", in: app).exists ? element("settings.menu", in: app) : app.navigationBars.buttons["更多"]
        XCTAssertTrue(menu.waitForExistence(timeout: patience), "no menu in the bar\n\(app.debugDescription)")
        menu.tap()
        let byId = element(id, in: app)
        let item = byId.waitForExistence(timeout: 3) ? byId : app.buttons[title]
        XCTAssertTrue(item.waitForExistence(timeout: patience), "no \(title) in the menu\n\(app.debugDescription)")
        return item
    }

    /// Closes a menu by tapping beside it.
    @MainActor
    private func dismissMenu(in app: XCUIApplication) {
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.2, dy: 0.5)).tap()
    }

    /// Lets a save that is out reach Alfred: a tap is sent half a second later.
    @MainActor
    private func settle(seconds: TimeInterval) {
        usleep(UInt32(seconds * 1_000_000))
    }

    /// Pulls the list down from its top, which reads the settings again.
    @MainActor
    private func pullToRefresh(in app: XCUIApplication) {
        for _ in 0..<3 { app.swipeDown() }
        let from = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.3))
        from.press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.85)))
        settle(seconds: 1.5)
    }

    // MARK: The chat

    @MainActor
    private func send(_ text: String, in app: XCUIApplication) {
        let field = element("composer", in: app)
        XCTAssertTrue(field.waitForExistence(timeout: patience), "no composer\n\(app.debugDescription)")
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

    /// A stored message from Alfred that is not among `known` and says `fragment`.
    @MainActor
    private func newReply(_ known: [String], containing fragment: String, in app: XCUIApplication) -> XCUIElement {
        app.staticTexts.matching(
            NSPredicate(format: "identifier BEGINSWITH 'message.out.' AND NOT (identifier IN %@) AND label CONTAINS %@", known, fragment)
        ).firstMatch
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

    /// Scrolls the list until `target` lies between the navigation bar and the tab bar, and waits for the list to stop.
    /// The bars are glass, so XCUITest counts a row under one as hittable, but a tap there lands on the bar.
    @MainActor
    private func scrollBetweenBars(_ target: XCUIElement, in app: XCUIApplication) {
        XCTAssertTrue(find(target, in: app, timeout: patience), "the element to scroll to is not there\n\(app.debugDescription)")
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

    /// Taps `target` once it is hittable and has kept the same frame over three looks in a row: a menu or a dialog that
    /// is still opening puts its buttons somewhere else than where the tap is computed.
    @MainActor
    private func tapWhenSettled(_ target: XCUIElement, in app: XCUIApplication) {
        XCTAssertTrue(target.waitForExistence(timeout: patience), "the element to tap is not there\n\(app.debugDescription)")
        var previous: CGRect?
        var steady = 0
        let settled = wait(timeout: patience) {
            let frame = target.frame
            steady = (target.isHittable && frame == previous) ? steady + 1 : 0
            previous = frame
            return steady >= 3
        }
        XCTAssertTrue(settled, "the element did not come to rest and become hittable\n\(app.debugDescription)")
        target.tap()
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

    // MARK: Notifications

    /// Answers the system's question about notifications, if it is asked: it is asked once per install, when the app
    /// first pairs. With no wait, it answers one that is already there.
    @MainActor
    private func allowNotifications(waiting seconds: TimeInterval = 0) {
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let alert = springboard.alerts.firstMatch
        guard alert.waitForExistence(timeout: seconds) else { return }
        let allow = alert.buttons.matching(NSPredicate(format: "label IN {'Allow', '允许'}")).firstMatch
        XCTAssertTrue(allow.exists, "the notification question has no Allow button\n\(springboard.debugDescription)")
        allow.tap()
        XCTAssertTrue(alert.waitForNonExistence(timeout: patience))
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
        allowNotifications()
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
            let confirm = app.sheets.buttons["取消配对"].firstMatch
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
