import XCTest

/// Pairs the app with a running `node scripts/app-dev.ts` and works Alfred's profile page, which the avatar in the chat's
/// header opens: the 规则 and 记忆 segments pinned at the top, over content that starts with the avatar large over his name,
/// and ALFRED.md shown as Markdown and edited in place. The 记忆 part has its own tests (`MemoryUITests`). The pairing comes from the environment variable `ALFRED_PAIRING` (pass `TEST_RUNNER_ALFRED_PAIRING` to
/// xcodebuild); without it the tests skip themselves. Nothing here runs the model.
///
/// A new stack's workspace holds Alfred's default ALFRED.md, which starts with `# Workspace rules`. The tests that change
/// the file write their own text through the editor (`ensureBaseline`) and leave the stack's ALFRED.md changed, so the
/// first test accepts the heading of the default text and of theirs.
///
/// The conflict test changes the file behind the app's back with the device token from the pairing, over the same
/// workbench API the app uses.
///
/// When `ALFRED_SHOTS` names a directory (pass `TEST_RUNNER_ALFRED_SHOTS`), the tests save screenshots of the page, the
/// editor and the conflict alert there, in the appearance the device has.
final class ProfileUITests: XCTestCase {
    private let patience: TimeInterval = 30

    /// The heading of the default ALFRED.md of a new stack.
    private let defaultHeading = "Workspace rules"
    /// The text the tests start from, and the heading it shows.
    private let baselineHeading = "Alfred 工作规则"
    private let baselineItem = "报告开头先写三行摘要。"
    private var baseline: String { "# \(baselineHeading)\n\n- \(baselineItem)\n" }

    // MARK: The page

    @MainActor
    func test1TheAvatarOpensTheProfileWithItsHeroAndTheRules() throws {
        let app = try launchPaired()
        let chatAvatar = element("chat.header.avatar", in: app)
        XCTAssertTrue(chatAvatar.waitForExistence(timeout: patience), "no avatar in the chat\n\(app.debugDescription)")
        XCTAssertEqual(chatAvatar.frame.width, 72, accuracy: 1, "the avatar changed size")
        XCTAssertEqual(chatAvatar.elementType, .button, "the avatar is not a button\n\(app.debugDescription)")
        chatAvatar.tap()

        XCTAssertTrue(element("profile.page", in: app).waitForExistence(timeout: patience), "the avatar did not open the profile\n\(app.debugDescription)")

        // The segmented control is pinned at the top, and the hero, the avatar 128 pt and centred over the name, is the
        // first thing under it. 规则 is the segment that shows first.
        let avatar = element("profile.avatar", in: app)
        let name = element("profile.name", in: app)
        let parts = element("profile.parts", in: app)
        XCTAssertTrue(avatar.waitForExistence(timeout: patience), "no avatar on the profile\n\(app.debugDescription)")
        XCTAssertEqual(avatar.frame.width, 128, accuracy: 1)
        XCTAssertEqual(avatar.frame.height, 128, accuracy: 1)
        XCTAssertEqual(avatar.frame.midX, app.frame.midX, accuracy: 2)
        XCTAssertTrue(name.exists, "no name\n\(app.debugDescription)")
        XCTAssertEqual(name.label, "Alfred")
        XCTAssertEqual(name.frame.midX, app.frame.midX, accuracy: 2)
        XCTAssertGreaterThanOrEqual(name.frame.minY, avatar.frame.maxY - 1, "the name is not under the avatar")
        XCTAssertTrue(parts.exists, "no segmented control\n\(app.debugDescription)")
        XCTAssertGreaterThanOrEqual(avatar.frame.minY, parts.frame.maxY - 1, "the avatar is not under the segmented control")
        XCTAssertTrue(app.buttons["规则"].exists && app.buttons["记忆"].exists, "the segments are not 规则 and 记忆\n\(app.debugDescription)")
        XCTAssertTrue(app.buttons["规则"].isSelected, "规则 is not the first segment")
        XCTAssertFalse(app.buttons["记忆"].isSelected)

        // The bar has the standard back button, which says where it goes, and 编辑 on the trailing side.
        let back = backButton(in: app)
        XCTAssertTrue(back.exists, "no back button\n\(app.debugDescription)")
        let edit = element("profile.edit", in: app)
        XCTAssertTrue(edit.exists, "no 编辑 button\n\(app.debugDescription)")
        XCTAssertGreaterThan(edit.frame.midX, app.frame.midX, "编辑 is not on the trailing side")

        // The rules: the seeded ALFRED.md's heading shows as a heading, not as Markdown source. A stack that an earlier run
        // of these tests changed shows the heading of their text instead (the one of `ensureBaseline`, or `规则 <stamp>`).
        let rulesText = element("profile.rules.text", in: app)
        XCTAssertTrue(rulesText.waitForExistence(timeout: patience), "the rules do not show\n\(app.debugDescription)")
        let heading = try XCTUnwrap(topmostText(in: rulesText), "the rules show no text\n\(app.debugDescription)").label
        let known = heading == defaultHeading || heading == baselineHeading || heading.hasPrefix("规则 ")
        XCTAssertTrue(known, "the first line of the rules is \(heading), not the seeded heading\n\(app.debugDescription)")
        XCTAssertFalse(app.staticTexts["# \(heading)"].exists, "the Markdown source shows instead of the rendering")
        snapshot("profile")

        // 记忆 shows its list, with ＋ and no 编辑, under the same pinned control with the hero as its first row.
        let partsFrame = parts.frame
        app.buttons["记忆"].tap()
        XCTAssertTrue(element("memory.add", in: app).waitForExistence(timeout: patience), "记忆 shows no list\n\(app.debugDescription)")
        XCTAssertTrue(app.buttons["记忆"].isSelected, "记忆 is not selected")
        XCTAssertFalse(rulesText.exists, "记忆 still shows the rules")
        XCTAssertFalse(edit.exists, "记忆 has an 编辑 button")
        XCTAssertTrue(element("profile.avatar", in: app).exists && element("profile.name", in: app).exists, "记忆 has no hero")
        XCTAssertEqual(parts.frame, partsFrame, "the segmented control moved between the parts")
        app.buttons["规则"].tap()
        XCTAssertTrue(app.staticTexts[heading].waitForExistence(timeout: patience), "规则 does not show the rules again\n\(app.debugDescription)")

        // The back button returns to the chat, where the avatar is still 72 pt and centred.
        back.tap()
        XCTAssertTrue(element("profile.page", in: app).waitForNonExistence(timeout: patience), "the profile stayed\n\(app.debugDescription)")
        XCTAssertTrue(chatAvatar.waitForExistence(timeout: patience), "no avatar after coming back\n\(app.debugDescription)")
        XCTAssertEqual(chatAvatar.frame.width, 72, accuracy: 1)
        XCTAssertEqual(chatAvatar.frame.midX, app.frame.midX, accuracy: 2)
    }

    // MARK: Editing

    @MainActor
    func test2EditingChangesTheTextAndASavedTextShowsAfterLeavingAndReturning() throws {
        let app = try launchPaired()
        openProfile(in: app)
        ensureBaseline(in: app)

        // The editor: 取消 and 保存 in the bar and no back button, the segmented control off, a count under the text.
        let stamp = String(Int(Date().timeIntervalSince1970))
        let heading = "规则 \(stamp)"
        let item = "回复之前先看一眼 ALFRED.md"
        let text = "# \(heading)\n\n- \(item)\n"
        tapWhenSettled(element("profile.edit", in: app), in: app)
        let editor = element("profile.rules.editor", in: app)
        XCTAssertTrue(editor.waitForExistence(timeout: patience), "the editor did not open\n\(app.debugDescription)")
        XCTAssertEqual(editor.value as? String, baseline, "the editor does not hold the rules")
        XCTAssertTrue(element("profile.cancel", in: app).exists, "no 取消\n\(app.debugDescription)")
        XCTAssertTrue(element("profile.save", in: app).exists, "no 保存\n\(app.debugDescription)")
        XCTAssertFalse(element("profile.edit", in: app).exists, "编辑 stayed while editing")
        XCTAssertFalse(backButton(in: app).exists, "the back button stayed while editing\n\(app.debugDescription)")
        XCTAssertFalse(element("profile.parts", in: app).isEnabled, "the segmented control is on while editing")
        XCTAssertFalse(element("profile.save", in: app).isEnabled, "保存 is on while the text is unchanged")
        XCTAssertEqual(element("profile.rules.count", in: app).label, "\(baseline.utf8.count) / 8192")

        // Changing the text turns 保存 on and moves the count by the UTF-8 bytes typed.
        replaceText(in: editor, with: text)
        XCTAssertTrue(wait(timeout: patience) { editor.value as? String == text }, "the editor holds \(String(describing: editor.value))")
        XCTAssertTrue(wait(timeout: patience) { element("profile.save", in: app).isEnabled }, "保存 stayed off after a change\n\(app.debugDescription)")
        XCTAssertEqual(element("profile.rules.count", in: app).label, "\(text.utf8.count) / 8192")
        snapshot("profile-editor")

        // Saving shows the new text, rendered, and leaves the editor.
        element("profile.save", in: app).tap()
        XCTAssertTrue(app.staticTexts[heading].waitForExistence(timeout: patience), "the saved heading does not show\n\(app.debugDescription)")
        XCTAssertTrue(app.staticTexts[item].exists, "the saved item does not show")
        XCTAssertFalse(app.staticTexts[baselineHeading].exists, "the old heading is still shown")
        XCTAssertTrue(editor.waitForNonExistence(timeout: patience), "the editor stayed after the save")
        XCTAssertTrue(backButton(in: app).waitForExistence(timeout: patience), "no back button after the save\n\(app.debugDescription)")
        XCTAssertTrue(element("profile.parts", in: app).isEnabled, "the segmented control stayed off")

        // Leave and come back: the new text is there.
        backButton(in: app).tap()
        XCTAssertTrue(element("profile.page", in: app).waitForNonExistence(timeout: patience), "the profile stayed\n\(app.debugDescription)")
        openProfile(in: app)
        XCTAssertTrue(app.staticTexts[heading].waitForExistence(timeout: patience), "the new text is gone after leaving and returning\n\(app.debugDescription)")
        XCTAssertTrue(app.staticTexts[item].exists)

        // A new launch reads it from Alfred, which is where the save went.
        let again = try launchPaired()
        openProfile(in: again)
        XCTAssertTrue(again.staticTexts[heading].waitForExistence(timeout: patience), "Alfred does not hold the saved text\n\(again.debugDescription)")
        XCTAssertTrue(again.staticTexts[item].exists)
    }

    @MainActor
    func test3CancellingAChangedTextAsksFirst() throws {
        let app = try launchPaired()
        openProfile(in: app)
        ensureBaseline(in: app)

        // An unchanged text is left at once.
        tapWhenSettled(element("profile.edit", in: app), in: app)
        let editor = element("profile.rules.editor", in: app)
        XCTAssertTrue(editor.waitForExistence(timeout: patience), "the editor did not open\n\(app.debugDescription)")
        tapWhenSettled(element("profile.cancel", in: app), in: app)
        XCTAssertTrue(editor.waitForNonExistence(timeout: patience), "取消 asked about a text that was not changed\n\(app.debugDescription)")
        XCTAssertEqual(app.sheets.count, 0, "取消 asked about a text that was not changed")
        XCTAssertTrue(app.staticTexts[baselineHeading].exists, "the rules do not show after 取消")

        // A changed text asks first. Keeping it leaves the editor as it was, with the text.
        tapWhenSettled(element("profile.edit", in: app), in: app)
        XCTAssertTrue(editor.waitForExistence(timeout: patience), "the editor did not open\n\(app.debugDescription)")
        let changed = baseline + "- 这一行不会被保存\n"
        replaceText(in: editor, with: changed)
        XCTAssertTrue(wait(timeout: patience) { editor.value as? String == changed }, "the editor holds \(String(describing: editor.value))")
        tapWhenSettled(element("profile.cancel", in: app), in: app)
        let discard = app.sheets.buttons["放弃修改"]
        XCTAssertTrue(discard.waitForExistence(timeout: patience), "取消 did not ask before dropping the changes\n\(app.debugDescription)")
        // The dialog opens from the 取消 button as a popover, which has no cancel button of its own: a tap outside it keeps
        // the edit.
        element("PopoverDismissRegion", in: app).tap()
        XCTAssertTrue(discard.waitForNonExistence(timeout: patience), "the dialog stayed\n\(app.debugDescription)")
        XCTAssertEqual(editor.value as? String, changed, "keeping the edit lost the text")
        XCTAssertTrue(element("profile.save", in: app).isEnabled, "保存 went off after keeping the edit")

        // Discarding goes back to the rules as they were saved.
        tapWhenSettled(element("profile.cancel", in: app), in: app)
        XCTAssertTrue(discard.waitForExistence(timeout: patience), "the second 取消 did not ask\n\(app.debugDescription)")
        discard.tap()
        XCTAssertTrue(editor.waitForNonExistence(timeout: patience), "the editor stayed after 放弃修改\n\(app.debugDescription)")
        XCTAssertTrue(app.staticTexts[baselineHeading].waitForExistence(timeout: patience), "the saved rules do not show\n\(app.debugDescription)")
        XCTAssertFalse(app.staticTexts["这一行不会被保存"].exists, "the discarded line shows")
    }

    @MainActor
    func test4AConflictOffersTheNewContentOrTheDraft() throws {
        let app = try launchPaired()
        openProfile(in: app)
        ensureBaseline(in: app)

        tapWhenSettled(element("profile.edit", in: app), in: app)
        let editor = element("profile.rules.editor", in: app)
        XCTAssertTrue(editor.waitForExistence(timeout: patience), "the editor did not open\n\(app.debugDescription)")
        let mine = baseline + "- 我写的一行\n"
        replaceText(in: editor, with: mine)
        XCTAssertTrue(wait(timeout: patience) { editor.value as? String == mine }, "the editor holds \(String(describing: editor.value))")

        // The file changes behind the app's back, so the edit is against an old version.
        let theirItem = "另一处写的一行 \(Int(Date().timeIntervalSince1970))"
        let theirs = "# \(baselineHeading)\n\n- \(theirItem)\n"
        try saveRulesBehindTheApp(theirs)

        // 取消 in the alert stays in the editor with the draft, and saving again conflicts again.
        tapWhenSettled(element("profile.save", in: app), in: app)
        let alert = app.alerts["ALFRED.md 已被改动"]
        XCTAssertTrue(alert.waitForExistence(timeout: patience), "no conflict alert\n\(app.debugDescription)")
        XCTAssertTrue(alert.buttons["载入新内容"].exists && alert.buttons["取消"].exists, "the alert does not offer 载入新内容 and 取消\n\(alert.debugDescription)")
        snapshot("profile-conflict")
        alert.buttons["取消"].tap()
        XCTAssertTrue(alert.waitForNonExistence(timeout: patience), "the alert stayed")
        XCTAssertTrue(editor.exists, "取消 left the editor")
        XCTAssertEqual(editor.value as? String, mine, "取消 lost the draft")
        tapWhenSettled(element("profile.save", in: app), in: app)
        XCTAssertTrue(alert.waitForExistence(timeout: patience), "a second save did not conflict again\n\(app.debugDescription)")

        // 载入新内容 replaces the draft with what the file holds now, and nothing has been saved over it.
        alert.buttons["载入新内容"].tap()
        XCTAssertTrue(wait(timeout: patience) { editor.value as? String == theirs }, "the editor holds \(String(describing: editor.value)), not the new content")
        XCTAssertTrue(wait(timeout: patience) { !element("profile.save", in: app).isEnabled }, "保存 is on over the reloaded text")
        XCTAssertEqual(app.alerts.count, 0)

        // Cancelling the unchanged, reloaded text shows the other side's line.
        tapWhenSettled(element("profile.cancel", in: app), in: app)
        XCTAssertTrue(app.staticTexts[theirItem].waitForExistence(timeout: patience), "the rules do not show the reloaded text\n\(app.debugDescription)")
        XCTAssertFalse(app.staticTexts["我写的一行"].exists)
    }

    // MARK: Scrolling

    @MainActor
    func test5TheHeroScrollsWithTheRulesAndTheControlStaysPinned() throws {
        let app = try launchPaired()
        openProfile(in: app)
        ensureBaseline(in: app)

        // A text longer than the screen, so that there is something to scroll.
        let items = (1...30).map { "- 第\($0)条规则" }.joined(separator: "\n")
        let long = "# \(baselineHeading)\n\n\(items)\n"
        tapWhenSettled(element("profile.edit", in: app), in: app)
        let editor = element("profile.rules.editor", in: app)
        XCTAssertTrue(editor.waitForExistence(timeout: patience), "the editor did not open\n\(app.debugDescription)")
        replaceText(in: editor, with: long)
        XCTAssertTrue(wait(timeout: patience) { editor.value as? String == long }, "the editor holds \(String(describing: editor.value))")
        tapWhenSettled(element("profile.save", in: app), in: app)
        XCTAssertTrue(editor.waitForNonExistence(timeout: patience), "the editor stayed after the save")
        XCTAssertTrue(app.staticTexts["第30条规则"].waitForExistence(timeout: patience), "the long text does not show\n\(app.debugDescription)")

        // Scrolling moves the avatar and the name out of the way; the control stays where it is, over the text.
        let avatar = element("profile.avatar", in: app)
        let parts = element("profile.parts", in: app)
        let partsFrame = parts.frame
        let avatarTop = avatar.frame.minY
        XCTAssertGreaterThanOrEqual(avatarTop, partsFrame.maxY - 1, "the avatar is not under the segmented control")
        app.swipeUp()
        app.swipeUp()
        XCTAssertTrue(wait(timeout: patience) { !avatar.exists || avatar.frame.maxY < partsFrame.maxY + 1 }, "the avatar did not scroll away with the text (at \(avatar.frame))")
        XCTAssertEqual(parts.frame, partsFrame, "the segmented control moved with the text")
        snapshot("profile-scrolled")
        // The control still works where it is: a tap on 记忆 shows the memories, with the hero at the top of its list.
        app.buttons["记忆"].tap()
        XCTAssertTrue(element("memory.add", in: app).waitForExistence(timeout: patience), "记忆 shows no list\n\(app.debugDescription)")
        XCTAssertTrue(app.buttons["记忆"].isSelected, "the tap on 记忆 did not select it")
        app.buttons["规则"].tap()
        XCTAssertTrue(app.staticTexts["第30条规则"].waitForExistence(timeout: patience) || app.staticTexts["第1条规则"].waitForExistence(timeout: patience), "规则 does not show the long text again\n\(app.debugDescription)")

        // Scrolling back brings the hero back.
        app.swipeDown()
        app.swipeDown()
        app.swipeDown()
        XCTAssertTrue(wait(timeout: patience) { avatar.exists && abs(avatar.frame.minY - avatarTop) < 1 }, "the hero did not come back (avatar at \(avatar.frame))")

        // The stack is left with the baseline, as the other tests expect.
        ensureBaseline(in: app)
    }

    // MARK: The screen

    /// Taps the chat's avatar and waits for the page.
    @MainActor
    private func openProfile(in app: XCUIApplication) {
        let avatar = element("chat.header.avatar", in: app)
        tapWhenSettled(avatar, in: app, needsHittable: false)
        XCTAssertTrue(element("profile.page", in: app).waitForExistence(timeout: patience), "the avatar did not open the profile\n\(app.debugDescription)")
    }

    /// The standard back button of the page: the one in the navigation bar that is not 编辑.
    @MainActor
    private func backButton(in app: XCUIApplication) -> XCUIElement {
        app.navigationBars.buttons.matching(NSPredicate(format: "identifier == 'BackButton' OR label == '对话'")).firstMatch
    }

    /// The text in `container` that is highest up, which is the first line of the rules.
    @MainActor
    private func topmostText(in container: XCUIElement) -> XCUIElement? {
        container.staticTexts.allElementsBoundByIndex
            .filter { $0.exists && !$0.frame.isEmpty }
            .min { $0.frame.minY < $1.frame.minY }
    }

    /// Waits for the rules to load, and writes `baseline` unless the file holds exactly that: a new stack has Alfred's
    /// default text, and an earlier test may have left another. The editor is where the text is read from.
    @MainActor
    private func ensureBaseline(in app: XCUIApplication) {
        let edit = element("profile.edit", in: app)
        XCTAssertTrue(wait(timeout: patience) { edit.exists && edit.isEnabled }, "the rules did not load\n\(app.debugDescription)")
        tapWhenSettled(edit, in: app)
        let editor = element("profile.rules.editor", in: app)
        XCTAssertTrue(editor.waitForExistence(timeout: patience), "the editor did not open\n\(app.debugDescription)")
        if editor.value as? String == baseline {
            tapWhenSettled(element("profile.cancel", in: app), in: app)
            XCTAssertTrue(editor.waitForNonExistence(timeout: patience), "the editor stayed after 取消\n\(app.debugDescription)")
            XCTAssertTrue(app.staticTexts[baselineHeading].waitForExistence(timeout: patience), "the baseline does not show\n\(app.debugDescription)")
            return
        }
        replaceText(in: editor, with: baseline)
        XCTAssertTrue(wait(timeout: patience) { editor.value as? String == baseline }, "the editor holds \(String(describing: editor.value))")
        tapWhenSettled(element("profile.save", in: app), in: app)
        XCTAssertTrue(app.staticTexts[baselineHeading].waitForExistence(timeout: patience), "the baseline was not saved\n\(app.debugDescription)")
        XCTAssertTrue(editor.waitForNonExistence(timeout: patience), "the editor stayed after the save")
    }

    /// Replaces what the editor holds with `text`. The editor takes focus with the caret at the end of its text when it
    /// opens, so deleting as many characters as it holds clears it.
    @MainActor
    private func replaceText(in field: XCUIElement, with text: String) {
        let held = (field.value as? String)?.count ?? 0
        field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: held) + text)
    }

    // MARK: Behind the app's back

    private struct BehindTheApp: Error, CustomStringConvertible {
        let description: String
    }

    /// Replaces ALFRED.md through the workbench API with the device token of the pairing, as a second device would.
    @MainActor
    private func saveRulesBehindTheApp(_ text: String) throws {
        let pairing = try XCTUnwrap(ProcessInfo.processInfo.environment["ALFRED_PAIRING"])
        let object = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(pairing.utf8)) as? [String: Any])
        let server = try XCTUnwrap((object["server"] as? String).flatMap(URL.init(string:)))
        let token = try XCTUnwrap((object["device"] as? [String: Any])?["token"] as? String)

        func call(_ method: String, _ path: String, body: [String: Any]? = nil) throws -> Data {
            var request = URLRequest(url: server.appending(path: path))
            request.httpMethod = method
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            if let body {
                request.setValue("application/json", forHTTPHeaderField: "Content-Type")
                request.httpBody = try JSONSerialization.data(withJSONObject: body)
            }
            nonisolated(unsafe) var outcome: Result<Data, any Error> = .failure(BehindTheApp(description: "no answer"))
            let done = DispatchSemaphore(value: 0)
            URLSession.shared.dataTask(with: request) { data, response, error in
                defer { done.signal() }
                if let error {
                    outcome = .failure(error)
                } else if let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) {
                    outcome = .success(data ?? Data())
                } else {
                    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                    outcome = .failure(BehindTheApp(description: "\(method) \(path): \(status) \(String(decoding: data ?? Data(), as: UTF8.self))"))
                }
            }.resume()
            XCTAssertEqual(done.wait(timeout: .now() + patience), .success, "\(method) \(path) did not answer")
            return try outcome.get()
        }

        let current = try XCTUnwrap(try JSONSerialization.jsonObject(with: call("GET", "/api/rules")) as? [String: Any])
        let version = try XCTUnwrap(current["version"] as? String)
        _ = try call("POST", "/api/commands", body: ["type": "rules.save", "text": text, "version": version])
    }

    // MARK: Screenshots

    /// Saves a screenshot of the app as `<name>.png` when `ALFRED_SHOTS` names a directory, in the appearance the device has.
    /// The test cannot switch it (`XCUIDevice.shared.appearance` did not take effect on the screens of this app): run with
    /// `xcrun simctl ui <udid> appearance dark` for the dark ones, into another directory.
    @MainActor
    private func snapshot(_ name: String) {
        guard let directory = ProcessInfo.processInfo.environment["ALFRED_SHOTS"], !directory.isEmpty else { return }
        let folder = URL(fileURLWithPath: directory, isDirectory: true)
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        // The bars and the avatar's cover settle.
        usleep(1_000_000)
        try? XCUIScreen.main.screenshot().pngRepresentation.write(to: folder.appending(path: name + ".png"))
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
        answerNotificationPrompt()
        return app
    }

    /// Answers the system's request to send notifications, which the app makes once after it is installed and which keeps
    /// the app's controls from being hittable until it is answered.
    @MainActor
    private func answerNotificationPrompt() {
        let alert = XCUIApplication(bundleIdentifier: "com.apple.springboard").alerts.firstMatch
        guard alert.waitForExistence(timeout: 3) else { return }
        let allow = alert.buttons.matching(NSPredicate(format: "label IN %@", ["Allow", "允许"])).firstMatch
        (allow.exists ? allow : alert.buttons.firstMatch).tap()
        XCTAssertTrue(alert.waitForNonExistence(timeout: patience), "the notification prompt stayed")
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

    /// Taps `target` once it has kept the same frame over three looks in a row, and is hittable when `needsHittable`: a
    /// control that is still moving, in a bar that is changing or under the keyboard, gets a tap that lands somewhere else.
    /// The chat's avatar is not always reported hittable although a tap on it works (it is a button over the list, with a
    /// video layer in it), so that one is tapped on its frame alone and the page it opens is the check.
    @MainActor
    private func tapWhenSettled(_ target: XCUIElement, in app: XCUIApplication, needsHittable: Bool = true) {
        XCTAssertTrue(target.waitForExistence(timeout: patience), "the element to tap is not there\n\(app.debugDescription)")
        var previous: CGRect?
        var steady = 0
        let settled = wait(timeout: patience) {
            let frame = target.frame
            steady = ((target.isHittable || !needsHittable) && frame == previous) ? steady + 1 : 0
            previous = frame
            return steady >= 3
        }
        XCTAssertTrue(settled, "\(target.identifier) did not come to rest and become hittable (frame \(target.frame), hittable \(target.isHittable))\n\(app.debugDescription)")
        target.tap()
    }
}
