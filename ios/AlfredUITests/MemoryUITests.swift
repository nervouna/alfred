import XCTest

/// Pairs the app with a running `node scripts/app-dev.ts --seed-memories` and works the 记忆 part of Alfred's profile: his
/// long-term memories in sections by kind, the search, a memory's page, the form that changes one or adds one, and delete
/// behind a confirmation. The pairing comes from the environment variable `ALFRED_PAIRING` (pass `TEST_RUNNER_ALFRED_PAIRING`
/// to xcodebuild); without it the tests skip themselves. Nothing here runs the model.
///
/// The tests change the stack's memories, so they need a fresh stack (new state and workspace directories), and they run in
/// the order of their names: the first only reads, the second renames a memory, the third adds one, and the later ones
/// delete or conflict over the rest; the last adds enough memories for the list to scroll. The conflict tests and the last
/// one change memories behind the app's back with the device token from the pairing, over the same workbench API the app
/// uses.
///
/// When `ALFRED_SHOTS` names a directory (pass `TEST_RUNNER_ALFRED_SHOTS`), the tests save screenshots of the list, a
/// memory's page and the form there, in the appearance the device has.
final class MemoryUITests: XCTestCase {
    private let patience: TimeInterval = 30

    // The seeded memories (SEED_MEMORIES in scripts/app-dev.ts), by file, with what the tests look for in each.
    private let userFile = "memory-20261026-4k2p.md"
    private let preferenceFile = "prefer-short-answers.md"
    private let projectFile = "works-on-alfred.md"
    private let projectName = "Alfred project"
    private let projectDescription = "The owner builds Alfred, a personal agent with an iOS app."
    private let correctionFile = "do-not-guess-prices.md"
    private let correctionName = "Do not guess prices"
    private let correctionDescription = "Never quote a price that was not read from a source."
    private let correctionBody = "The owner corrected a reply that quoted a VPS price from memory. Quote a price only from a page read in this task, with its link."

    // MARK: The list

    @MainActor
    func test1TheKindsAreSectionsInOrderAndSearchNarrowsTheList() throws {
        let app = try launchPaired()
        openMemories(in: app)

        // Four sections, one for each kind, in the order 关于你, 偏好, 项目, 纠正; none for 其他, which has no memory.
        let headers = ["user", "preference", "project", "correction"].map { "memory.section.\($0)" }
        let order = scrollThroughHeaders(in: app)
        XCTAssertEqual(order, headers, "the sections are not the four kinds in order\n\(app.debugDescription)")
        XCTAssertFalse(element("memory.section.other", in: app).exists, "a section for kind 其他 with no memory")
        scrollToTop(in: app)

        // A row shows the name, the description and the date, and all four are in the prompt.
        let correction = row(correctionFile, in: app)
        XCTAssertTrue(correction.waitForExistence(timeout: patience), "the list has no row for \(correctionName)\n\(app.debugDescription)")
        for part in [correctionName, correctionDescription, "2026-10-29"] {
            XCTAssertTrue(correction.label.contains(part), "the row does not show \(part): \(correction.label)")
        }
        XCTAssertFalse(correction.label.contains("不在提示中"), "a memory in the prompt is marked as outside it")
        XCTAssertFalse(app.staticTexts["不在提示中"].exists)
        snapshot("memory-list")
        scrollThroughHeaders(in: app)
        snapshot("memory-list-end")
        scrollToTop(in: app)

        // The hero comes first at rest, with the control directly under it, and the first section under the control.
        let parts = element("profile.parts", in: app)
        let avatar = element("profile.avatar", in: app)
        XCTAssertTrue(avatar.exists && parts.exists, "no avatar or control\n\(app.debugDescription)")
        assertControlUnderHero(in: app)
        XCTAssertGreaterThanOrEqual(element("memory.section.user", in: app).frame.minY, parts.frame.maxY - 1, "the first section is not under the control")

        // Search matches the name, the description and the body, and a query that matches nothing says so.
        // The search field is a button in the bar until it is opened, and takes the focus when it is.
        let searchButton = app.navigationBars.buttons.matching(NSPredicate(format: "label CONTAINS[c] 'search' OR label CONTAINS '搜索'")).firstMatch
        tapWhenSettled(searchButton, in: app)
        let search = app.searchFields.firstMatch
        XCTAssertTrue(search.waitForExistence(timeout: patience), "no search field\n\(app.debugDescription)")
        search.typeText("Alfred")
        XCTAssertTrue(wait(timeout: patience) { !row(correctionFile, in: app).exists && !row(preferenceFile, in: app).exists && !row(userFile, in: app).exists },
                      "searching for a name left other memories\n\(app.debugDescription)")
        XCTAssertTrue(row(projectFile, in: app).exists, "the project memory does not match its own name")
        clearSearch(in: app)

        search.typeText("personal agent")
        XCTAssertTrue(wait(timeout: patience) { row(projectFile, in: app).exists && !row(correctionFile, in: app).exists }, "searching for words in a description did not find it\n\(app.debugDescription)")
        clearSearch(in: app)

        search.typeText("VPS")
        XCTAssertTrue(wait(timeout: patience) { row(correctionFile, in: app).exists && !row(projectFile, in: app).exists }, "searching for words in a body did not find it\n\(app.debugDescription)")
        XCTAssertFalse(element("memory.section.project", in: app).exists, "a section with no match stayed")
        clearSearch(in: app)

        search.typeText("没有这个词")
        XCTAssertTrue(element("memory.noMatch", in: app).waitForExistence(timeout: patience) || app.staticTexts.matching(NSPredicate(format: "label CONTAINS '没有这个词'")).firstMatch.exists,
                      "a search with no match says nothing\n\(app.debugDescription)")
        XCTAssertFalse(row(correctionFile, in: app).exists)
        clearSearch(in: app)
        XCTAssertTrue(row(correctionFile, in: app).waitForExistence(timeout: patience), "clearing the search did not bring the list back")
    }

    // MARK: A memory

    @MainActor
    func test2AMemoryOpensAndAnEditedNameShowsInThePageAndInTheList() throws {
        let app = try launchPaired()
        openMemories(in: app)
        openMemory(correctionFile, in: app)

        // The page: the name, the kind, the date, the description and the body.
        XCTAssertEqual(element("memory.detail.name", in: app).label, correctionName)
        XCTAssertEqual(element("memory.detail.kind", in: app).label, "纠正")
        XCTAssertEqual(element("memory.detail.date", in: app).label, "2026-10-29")
        XCTAssertEqual(element("memory.detail.description", in: app).label, correctionDescription)
        XCTAssertTrue(hasText("Quote a price only from a page read in this task", in: app), "the body does not show\n\(app.debugDescription)")
        XCTAssertTrue(element("memory.detail.edit", in: app).isEnabled)
        snapshot("memory-detail")

        // 编辑 pushes the form with the memory in it: no back button, 取消 and 保存 in the bar, 保存 off.
        tapWhenSettled(element("memory.detail.edit", in: app), in: app)
        let name = element("memory.form.name", in: app)
        XCTAssertTrue(name.waitForExistence(timeout: patience), "the form did not open\n\(app.debugDescription)")
        XCTAssertEqual(name.value as? String, correctionName)
        XCTAssertEqual(element("memory.form.description", in: app).value as? String, correctionDescription)
        XCTAssertEqual(element("memory.form.body", in: app).value as? String, correctionBody)
        XCTAssertTrue(valueOrLabel(of: element("memory.form.kind", in: app)).contains("纠正"), "the picker does not show 纠正")
        XCTAssertTrue(app.navigationBars["编辑记忆"].exists, "the form is not titled 编辑记忆\n\(app.debugDescription)")
        XCTAssertTrue(element("memory.form.cancel", in: app).exists)
        XCTAssertFalse(backButton(in: app).exists, "the back button stayed on the form\n\(app.debugDescription)")
        XCTAssertFalse(element("memory.form.save", in: app).isEnabled, "保存 is on while nothing changed")
        XCTAssertEqual(element("memory.form.count", in: app).label, "\(correctionBody.utf8.count) / 8192")
        snapshot("memory-form-edit")

        // A name with a new ending turns 保存 on; an empty name turns it off.
        let renamed = correctionName + " ever"
        append(" ever", to: name)
        XCTAssertTrue(wait(timeout: patience) { element("memory.form.save", in: app).isEnabled }, "保存 stayed off after a change\n\(app.debugDescription)")
        append(String(repeating: XCUIKeyboardKey.delete.rawValue, count: renamed.count), to: name)
        XCTAssertTrue(wait(timeout: patience) { !element("memory.form.save", in: app).isEnabled }, "保存 is on with an empty name\n\(app.debugDescription)")
        append(renamed, to: name)
        XCTAssertTrue(wait(timeout: patience) { element("memory.form.save", in: app).isEnabled }, "保存 stayed off\n\(app.debugDescription)")

        // Saving goes back to the memory's page, which shows the new name; the list shows it too.
        tapWhenSettled(element("memory.form.save", in: app), in: app)
        XCTAssertTrue(name.waitForNonExistence(timeout: patience), "the form stayed after the save\n\(app.debugDescription)")
        XCTAssertTrue(wait(timeout: patience) { element("memory.detail.name", in: app).label == renamed }, "the page does not show the new name: \(element("memory.detail.name", in: app).label)")
        backButton(in: app).tap()
        let listed = row(correctionFile, in: app)
        XCTAssertTrue(listed.waitForExistence(timeout: patience), "the list lost the memory\n\(app.debugDescription)")
        XCTAssertTrue(wait(timeout: patience) { row(correctionFile, in: app).label.contains(renamed) }, "the list does not show the new name: \(listed.label)")

        // A new launch reads it from Alfred, which is where the save went.
        let again = try launchPaired()
        openMemories(in: again)
        XCTAssertTrue(wait(timeout: patience) { row(correctionFile, in: again).exists && row(correctionFile, in: again).label.contains(renamed) },
                      "Alfred does not hold the saved name\n\(again.debugDescription)")
    }

    // MARK: Adding

    @MainActor
    func test3AMemoryIsAddedFromTheFormInASheet() throws {
        let app = try launchPaired()
        openMemories(in: app)

        tapWhenSettled(element("memory.add", in: app), in: app)
        let name = element("memory.form.name", in: app)
        XCTAssertTrue(name.waitForExistence(timeout: patience), "the form did not open\n\(app.debugDescription)")
        XCTAssertTrue(app.navigationBars["新建记忆"].exists, "the form is not titled 新建记忆\n\(app.debugDescription)")
        let held = name.value as? String
        XCTAssertTrue(held == nil || held == "" || held == "名称", "the name field is not empty: \(String(describing: held))")
        XCTAssertFalse(element("memory.form.save", in: app).isEnabled, "保存 is on for an empty form")
        XCTAssertEqual(element("memory.form.count", in: app).label, "0 / 8192")

        // A description alone is not enough.
        tapWhenSettled(element("memory.form.description", in: app), in: app)
        element("memory.form.description", in: app).typeText("Use kilometres and kilograms.")
        XCTAssertFalse(element("memory.form.save", in: app).isEnabled, "保存 is on without a name")

        tapWhenSettled(name, in: app)
        name.typeText("Metric units")
        XCTAssertTrue(wait(timeout: patience) { element("memory.form.save", in: app).isEnabled }, "保存 stayed off with a name\n\(app.debugDescription)")

        chooseKind("偏好", in: app)
        let body = element("memory.form.body", in: app)
        tapWhenSettled(body, in: app)
        body.typeText("The owner thinks in metric units.")
        XCTAssertEqual(element("memory.form.count", in: app).label, "\("The owner thinks in metric units.".utf8.count) / 8192")
        snapshot("memory-form-new")

        tapWhenSettled(element("memory.form.save", in: app), in: app)
        XCTAssertTrue(name.waitForNonExistence(timeout: patience), "the sheet stayed after the save\n\(app.debugDescription)")

        // The new memory is in the list, under 偏好 with the memory that was there, and Alfred named its file from the name.
        let added = row("metric-units.md", in: app)
        XCTAssertTrue(added.waitForExistence(timeout: patience), "the list does not show the new memory\n\(app.debugDescription)")
        XCTAssertTrue(added.label.contains("Metric units") && added.label.contains("Use kilometres and kilograms."), "the row is wrong: \(added.label)")
        XCTAssertTrue(element("memory.section.preference", in: app).exists)
        scrollBetweenBars(row(preferenceFile, in: app), in: app)
        let preference = row(preferenceFile, in: app).frame
        let created = row("metric-units.md", in: app).frame
        XCTAssertLessThan(created.minY, preference.minY, "the newer memory is not listed first in its section")

        // It opens as a page of 偏好.
        openMemory("metric-units.md", in: app)
        XCTAssertEqual(element("memory.detail.name", in: app).label, "Metric units")
        XCTAssertEqual(element("memory.detail.kind", in: app).label, "偏好")
        XCTAssertTrue(hasText("The owner thinks in metric units.", in: app), "the body does not show\n\(app.debugDescription)")
    }

    // MARK: Leaving a form

    @MainActor
    func test4LeavingAChangedFormAsksFirst() throws {
        let app = try launchPaired()
        openMemories(in: app)

        // A form with nothing typed is left at once.
        tapWhenSettled(element("memory.add", in: app), in: app)
        let name = element("memory.form.name", in: app)
        XCTAssertTrue(name.waitForExistence(timeout: patience), "the form did not open\n\(app.debugDescription)")
        tapWhenSettled(element("memory.form.cancel", in: app), in: app)
        XCTAssertTrue(name.waitForNonExistence(timeout: patience), "取消 asked about a form that was not changed\n\(app.debugDescription)")

        // Typing something makes it ask. Keeping the draft leaves the form as it was.
        tapWhenSettled(element("memory.add", in: app), in: app)
        XCTAssertTrue(name.waitForExistence(timeout: patience), "the form did not open\n\(app.debugDescription)")
        tapWhenSettled(name, in: app)
        name.typeText("不会保存的记忆")
        tapWhenSettled(element("memory.form.cancel", in: app), in: app)
        let discard = app.sheets.buttons["放弃修改"]
        XCTAssertTrue(discard.waitForExistence(timeout: patience), "取消 did not ask before dropping the changes\n\(app.debugDescription)")
        // The dialog opens from the 取消 button as a popover, which has no cancel button of its own: a tap outside it keeps
        // the draft.
        element("PopoverDismissRegion", in: app).tap()
        XCTAssertTrue(discard.waitForNonExistence(timeout: patience), "the dialog stayed\n\(app.debugDescription)")
        XCTAssertEqual(name.value as? String, "不会保存的记忆", "keeping the draft lost the text")
        XCTAssertTrue(element("memory.form.save", in: app).isEnabled)

        // Discarding closes the form and adds nothing.
        tapWhenSettled(element("memory.form.cancel", in: app), in: app)
        XCTAssertTrue(discard.waitForExistence(timeout: patience), "the second 取消 did not ask\n\(app.debugDescription)")
        discard.tap()
        XCTAssertTrue(name.waitForNonExistence(timeout: patience), "the form stayed after 放弃修改\n\(app.debugDescription)")
        XCTAssertFalse(app.staticTexts["不会保存的记忆"].exists, "the discarded memory is listed")
        XCTAssertFalse(rows(in: app).contains { $0.label.contains("不会保存的记忆") }, "the discarded memory is listed")

        // The edit form of a memory asks the same way, and leaving it shows the memory as it was.
        openMemory(projectFile, in: app)
        tapWhenSettled(element("memory.detail.edit", in: app), in: app)
        let editName = element("memory.form.name", in: app)
        XCTAssertTrue(editName.waitForExistence(timeout: patience), "the form did not open\n\(app.debugDescription)")
        append(" 改", to: editName)
        tapWhenSettled(element("memory.form.cancel", in: app), in: app)
        XCTAssertTrue(discard.waitForExistence(timeout: patience), "取消 on a changed memory did not ask\n\(app.debugDescription)")
        discard.tap()
        XCTAssertTrue(editName.waitForNonExistence(timeout: patience), "the form stayed after 放弃修改\n\(app.debugDescription)")
        XCTAssertEqual(element("memory.detail.name", in: app).label, projectName, "the page shows the discarded text")
    }

    // MARK: Deleting

    @MainActor
    func test5ASwipeDeletesAMemoryAfterAConfirmationAndTheContextMenuAsksToo() throws {
        let app = try launchPaired()
        openMemories(in: app)
        let added = row("metric-units.md", in: app)
        scrollBetweenBars(added, in: app)

        // Swiping offers 删除, which asks first. The dialog hangs on the list (its arrow points at the hero, not at the row)
        // and has no cancel button of its own: a tap outside it keeps the memory.
        added.swipeLeft()
        swipeDeleteButton(in: app).tap()
        XCTAssertNotNil(dialogButton("删除", in: app), "删除 did not ask\n\(app.debugDescription)")
        snapshot("memory-delete")
        element("PopoverDismissRegion", in: app).tap()
        XCTAssertTrue(wait(timeout: patience) { dialogButton("删除", in: app, patience: 0) == nil }, "the dialog stayed\n\(app.debugDescription)")
        XCTAssertTrue(row("metric-units.md", in: app).exists, "dismissing the confirmation deleted the memory")

        // Confirming removes the row at once.
        scrollBetweenBars(row("metric-units.md", in: app), in: app)
        row("metric-units.md", in: app).swipeLeft()
        swipeDeleteButton(in: app).tap()
        try XCTUnwrap(dialogButton("删除", in: app), "删除 did not ask\n\(app.debugDescription)").tap()
        XCTAssertTrue(row("metric-units.md", in: app).waitForNonExistence(timeout: patience), "the deleted memory is still listed\n\(app.debugDescription)")

        // The context menu has 删除 too, behind the same question.
        let preference = row(preferenceFile, in: app)
        scrollBetweenBars(preference, in: app)
        preference.press(forDuration: 1.2)
        let menuDelete = app.buttons["删除"]
        XCTAssertTrue(menuDelete.waitForExistence(timeout: patience), "the context menu has no 删除\n\(app.debugDescription)")
        menuDelete.tap()
        XCTAssertNotNil(dialogButton("删除", in: app), "删除 in the context menu did not ask\n\(app.debugDescription)")
        element("PopoverDismissRegion", in: app).tap()
        XCTAssertTrue(wait(timeout: patience) { dialogButton("删除", in: app, patience: 0) == nil }, "the dialog stayed\n\(app.debugDescription)")
        XCTAssertTrue(row(preferenceFile, in: app).exists, "dismissing the confirmation deleted the memory")

        // A new launch reads the list from Alfred: the deleted memory is not there, the others are.
        let again = try launchPaired()
        openMemories(in: again)
        XCTAssertTrue(row(projectFile, in: again).waitForExistence(timeout: patience), "the other memories are gone\n\(again.debugDescription)")
        XCTAssertFalse(row("metric-units.md", in: again).exists, "Alfred still holds the deleted memory")
    }

    // MARK: Conflicts

    @MainActor
    func test6AStaleVersionOffersTheNewContentOrTheDraft() throws {
        let app = try launchPaired()
        openMemories(in: app)
        openMemory(projectFile, in: app)
        tapWhenSettled(element("memory.detail.edit", in: app), in: app)
        let name = element("memory.form.name", in: app)
        XCTAssertTrue(name.waitForExistence(timeout: patience), "the form did not open\n\(app.debugDescription)")
        append(" 我改的", to: name)
        XCTAssertTrue(wait(timeout: patience) { element("memory.form.save", in: app).isEnabled })

        // The memory changes behind the app's back, so the edit is against an old version.
        let theirs = "Alfred project (改自别处)"
        try WorkbenchAPI(environment: ProcessInfo.processInfo.environment).updateMemory(
            file: projectFile, name: theirs, description: projectDescription, kind: "project", body: "Changed on another device."
        )

        // 取消 in the alert stays in the form with the draft, and saving again conflicts again.
        tapWhenSettled(element("memory.form.save", in: app), in: app)
        let alert = app.alerts["记忆已被改动"]
        XCTAssertTrue(alert.waitForExistence(timeout: patience), "no conflict alert\n\(app.debugDescription)")
        XCTAssertTrue(alert.buttons["重新载入"].exists && alert.buttons["取消"].exists, "the alert does not offer 重新载入 and 取消\n\(alert.debugDescription)")
        snapshot("memory-conflict")
        alert.buttons["取消"].tap()
        XCTAssertTrue(alert.waitForNonExistence(timeout: patience), "the alert stayed")
        XCTAssertEqual(name.value as? String, projectName + " 我改的", "取消 lost the draft")
        tapWhenSettled(element("memory.form.save", in: app), in: app)
        XCTAssertTrue(alert.waitForExistence(timeout: patience), "a second save did not conflict again\n\(app.debugDescription)")

        // 重新载入 replaces the draft with the memory as it is now, and nothing has been saved over it.
        alert.buttons["重新载入"].tap()
        XCTAssertTrue(wait(timeout: patience) { name.value as? String == theirs }, "the form holds \(String(describing: name.value)), not the new content")
        XCTAssertEqual(element("memory.form.body", in: app).value as? String, "Changed on another device.")
        XCTAssertTrue(wait(timeout: patience) { !element("memory.form.save", in: app).isEnabled }, "保存 is on over the reloaded text")
        XCTAssertEqual(app.alerts.count, 0)

        // Leaving the unchanged form shows the other side's memory.
        tapWhenSettled(element("memory.form.cancel", in: app), in: app)
        XCTAssertTrue(wait(timeout: patience) { element("memory.detail.name", in: app).label == theirs }, "the page does not show the reloaded memory: \(element("memory.detail.name", in: app).label)")
    }

    @MainActor
    func test7AMemoryThatIsGoneClosesTheFormAndThePageAndLeavesTheList() throws {
        let app = try launchPaired()
        openMemories(in: app)
        openMemory(preferenceFile, in: app)
        tapWhenSettled(element("memory.detail.edit", in: app), in: app)
        let name = element("memory.form.name", in: app)
        XCTAssertTrue(name.waitForExistence(timeout: patience), "the form did not open\n\(app.debugDescription)")
        append(" 改", to: name)
        XCTAssertTrue(wait(timeout: patience) { element("memory.form.save", in: app).isEnabled })

        // The memory is deleted behind the app's back.
        try WorkbenchAPI(environment: ProcessInfo.processInfo.environment).deleteMemory(file: preferenceFile)

        tapWhenSettled(element("memory.form.save", in: app), in: app)
        XCTAssertTrue(name.waitForNonExistence(timeout: patience), "the form stayed after a 404\n\(app.debugDescription)")
        XCTAssertTrue(element("memory.detail", in: app).waitForNonExistence(timeout: patience), "the memory's page stayed after a 404\n\(app.debugDescription)")
        XCTAssertTrue(element("profile.parts", in: app).waitForExistence(timeout: patience), "the profile page is not showing\n\(app.debugDescription)")
        XCTAssertTrue(row(projectFile, in: app).waitForExistence(timeout: patience), "the list is not showing\n\(app.debugDescription)")
        XCTAssertTrue(row(preferenceFile, in: app).waitForNonExistence(timeout: patience), "the memory that is gone is still listed\n\(app.debugDescription)")
        XCTAssertEqual(app.alerts.count, 0, "a 404 raised an alert")
    }

    // MARK: Scrolling

    @MainActor
    func test8TheControlPinsWhenTheListScrollsUpToIt() throws {
        // A list a screen long cannot scroll the hero away: Alfred gets enough memories, behind the app's back, before the
        // app reads them.
        let api = try WorkbenchAPI(environment: ProcessInfo.processInfo.environment)
        for number in 1...8 {
            try api.createMemory(
                name: "Scroll filler \(number)", description: "Only here to make the list longer.",
                kind: "project", body: "Filler \(number)."
            )
        }
        let app = try launchPaired()
        openMemories(in: app)
        scrollToTop(in: app)

        // At rest the hero comes first and the control sits directly under it.
        let parts = element("profile.parts", in: app)
        let avatar = element("profile.avatar", in: app)
        assertControlUnderHero(in: app)
        let rest = parts.frame
        let avatarTop = avatar.frame.minY

        // A short scroll moves the hero and the control up together: the control has not reached the bar yet.
        drag(upBy: 90, in: app)
        XCTAssertTrue(wait(timeout: patience) { avatar.exists && avatar.frame.minY < avatarTop - 40 }, "the hero did not scroll with the list (at \(avatar.frame))")
        settle(avatar)
        let scrolledBy = avatarTop - avatar.frame.minY
        XCTAssertEqual(rest.minY - parts.frame.minY, scrolledBy, accuracy: 3, "the control did not move with the list (\(rest) to \(parts.frame), the hero by \(scrolledBy))")
        XCTAssertGreaterThan(parts.frame.minY, app.navigationBars.firstMatch.frame.maxY + pinnedGap + 16, "the control pinned before the list reached it (\(parts.frame))")
        snapshot("memory-list-scrolling")

        // Just short of the bar the control is still moving with the list.
        let barBottom = app.navigationBars.firstMatch.frame.maxY
        drag(parts, to: barBottom + 24, in: app)
        XCTAssertEqual(parts.frame.minY, barBottom + 24, accuracy: 6, "the control did not keep moving with the list up to the bar (\(parts.frame), bar \(barBottom))")

        // Scrolled up to it, the control stays at the bottom edge of the bar with the rows going under it.
        app.swipeUp()
        app.swipeUp()
        XCTAssertTrue(wait(timeout: patience) { !avatar.exists || avatar.frame.maxY < parts.frame.minY + 1 }, "the hero did not scroll away with the list (at \(avatar.frame))")
        settle(parts)
        assertControlPinned(in: app)
        snapshot("memory-list-pinned")
        // The control works where it is pinned: a tap on 规则 shows the rules, with the control under the hero again.
        app.buttons["规则"].tap()
        XCTAssertTrue(element("profile.rules.text", in: app).waitForExistence(timeout: patience), "规则 shows no rules\n\(app.debugDescription)")
        XCTAssertTrue(wait(timeout: patience) { samePlace(parts.frame, rest) }, "the control did not return under the hero in 规则 (\(parts.frame), at rest \(rest))")
        app.buttons["记忆"].tap()
        XCTAssertTrue(element("memory.add", in: app).waitForExistence(timeout: patience), "记忆 shows no list\n\(app.debugDescription)")
        XCTAssertTrue(wait(timeout: patience) { parts.frame == rest }, "the control did not return under the hero in 记忆 (\(parts.frame), at rest \(rest))")

        // Scrolling up again pins it, and scrolling back brings the hero back with the control under it.
        XCTAssertTrue(wait(timeout: patience) { !rows(in: app).isEmpty }, "the memories did not load again\n\(app.debugDescription)")
        app.swipeUp()
        app.swipeUp()
        XCTAssertTrue(wait(timeout: patience) { !avatar.exists || avatar.frame.maxY < parts.frame.minY + 1 }, "the hero did not scroll away with the list (at \(avatar.frame))")
        settle(parts)
        assertControlPinned(in: app)
        app.swipeDown()
        app.swipeDown()
        app.swipeDown()
        XCTAssertTrue(wait(timeout: patience) { avatar.exists && abs(avatar.frame.minY - avatarTop) < 1 }, "the hero did not come back (avatar at \(avatar.frame))")
        settle(parts)
        assertControlUnderHero(in: app)
        XCTAssertEqual(parts.frame, rest, "the control did not come back to its place under the hero")
    }

    // MARK: The screen

    /// Taps the chat's avatar, waits for the profile page, and shows 记忆.
    @MainActor
    private func openMemories(in app: XCUIApplication) {
        let avatar = element("chat.header.avatar", in: app)
        tapWhenSettled(avatar, in: app, needsHittable: false)
        XCTAssertTrue(element("profile.page", in: app).waitForExistence(timeout: patience), "the avatar did not open the profile\n\(app.debugDescription)")
        let memories = app.buttons["记忆"]
        XCTAssertTrue(memories.waitForExistence(timeout: patience), "no 记忆 segment\n\(app.debugDescription)")
        memories.tap()
        XCTAssertTrue(element("memory.add", in: app).waitForExistence(timeout: patience), "记忆 shows no list\n\(app.debugDescription)")
        // The list is read when it shows: wait for a row or the empty state.
        XCTAssertTrue(wait(timeout: patience) { !rows(in: app).isEmpty || element("memory.empty", in: app).exists },
                      "the memories did not load\n\(app.debugDescription)")
    }

    /// The row of a memory, whatever the list has scrolled to.
    @MainActor
    private func row(_ file: String, in app: XCUIApplication) -> XCUIElement {
        element("memory.row.\(file)", in: app)
    }

    @MainActor
    private func rows(in app: XCUIApplication) -> [XCUIElement] {
        app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'memory.row.'")).allElementsBoundByIndex
    }

    /// Scrolls to a memory's row, taps it, and waits for its page.
    @MainActor
    private func openMemory(_ file: String, in app: XCUIApplication) {
        let target = row(file, in: app)
        scrollBetweenBars(target, in: app)
        target.tap()
        XCTAssertTrue(element("memory.detail", in: app).waitForExistence(timeout: patience), "the row did not open the memory's page\n\(app.debugDescription)")
        XCTAssertTrue(element("memory.detail.name", in: app).waitForExistence(timeout: patience))
    }

    /// A button of a confirmation dialog, which opens from the row as a popover (or from the bottom as a sheet), once it
    /// shows. `nil` when it does not within `patience`.
    @MainActor
    private func dialogButton(_ title: String, in app: XCUIApplication, patience: TimeInterval? = nil) -> XCUIElement? {
        let limit = patience ?? self.patience
        let deadline = Date().addingTimeInterval(limit)
        repeat {
            for query in [app.sheets, app.popovers] {
                let button = query.buttons[title]
                if button.exists { return button }
            }
            usleep(250_000)
        } while Date() < deadline
        return nil
    }

    /// The 删除 a swipe on a row offers, once it shows.
    @MainActor
    private func swipeDeleteButton(in app: XCUIApplication) -> XCUIElement {
        let button = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'memory.delete.' OR label == '删除'")).firstMatch
        XCTAssertTrue(button.waitForExistence(timeout: patience), "the swipe offers no 删除\n\(app.debugDescription)")
        return button
    }

    /// The standard back button of the page.
    @MainActor
    private func backButton(in app: XCUIApplication) -> XCUIElement {
        app.navigationBars.buttons.matching(NSPredicate(format: "identifier == 'BackButton'")).firstMatch
    }

    /// Whether some text on the page holds `text`.
    @MainActor
    private func hasText(_ text: String, in app: XCUIApplication) -> Bool {
        app.descendants(matching: .any)
            .matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch.waitForExistence(timeout: patience)
    }

    /// What a control shows of its state: a picker's value, or its label.
    @MainActor
    private func valueOrLabel(of control: XCUIElement) -> String {
        "\(control.value as? String ?? "") \(control.label)"
    }

    /// The section headers the list shows, in the order they come into view from the top to the bottom of the list.
    @discardableResult
    @MainActor
    private func scrollThroughHeaders(in app: XCUIApplication) -> [String] {
        scrollToTop(in: app)
        var seen: [String] = []
        for _ in 0..<8 {
            let headers = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'memory.section.'"))
                .allElementsBoundByIndex
                .filter { $0.exists && !$0.frame.isEmpty }
                .sorted { $0.frame.minY < $1.frame.minY }
            for header in headers where !seen.contains(header.identifier) {
                seen.append(header.identifier)
            }
            let before = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'memory.row.'")).allElementsBoundByIndex.last?.frame
            app.swipeUp()
            usleep(600_000)
            let after = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'memory.row.'")).allElementsBoundByIndex.last?.frame
            if before == after { break }
        }
        return seen
    }

    @MainActor
    private func scrollToTop(in app: XCUIApplication) {
        // The avatar is hittable while it is half under the glass bars, so the top is where it lies below the navigation
        // bar, by the hero's own padding.
        let avatar = element("profile.avatar", in: app)
        let bar = app.navigationBars.firstMatch
        var tries = 0
        while !(avatar.exists && avatar.frame.minY >= bar.frame.maxY + 8) && tries < 8 {
            app.swipeDown()
            tries += 1
        }
        usleep(500_000)
    }

    // MARK: The control's place

    /// The page at rest: the hero comes first, below the navigation bar, and the segmented control sits directly under his
    /// name, with nothing between them.
    @MainActor
    private func assertControlUnderHero(in app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) {
        let avatar = element("profile.avatar", in: app)
        let name = element("profile.name", in: app)
        let parts = element("profile.parts", in: app)
        let bar = app.navigationBars.firstMatch.frame
        XCTAssertGreaterThanOrEqual(avatar.frame.minY, bar.maxY - 1, "the hero is not below the navigation bar (avatar \(avatar.frame), bar \(bar))", file: file, line: line)
        XCTAssertGreaterThanOrEqual(parts.frame.minY, name.frame.maxY - 1, "the segmented control (\(parts.frame)) is not under the name (\(name.frame))", file: file, line: line)
        XCTAssertLessThanOrEqual(parts.frame.minY - name.frame.maxY, 40, "the segmented control (\(parts.frame)) is not directly under the name (\(name.frame))", file: file, line: line)
    }

    /// The list scrolled up to the control: it sits at the bottom edge of the navigation bar.
    @MainActor
    private func assertControlPinned(in app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) {
        let parts = element("profile.parts", in: app)
        let bar = app.navigationBars.firstMatch.frame
        XCTAssertEqual(parts.frame.minY - bar.maxY, pinnedGap, accuracy: 4, "the segmented control (\(parts.frame)) is not at the bottom edge of the navigation bar (\(bar))", file: file, line: line)
    }

    /// How far below the navigation bar's bottom edge the pinned control's top edge lies: the control's own padding.
    private let pinnedGap: CGFloat = 8

    /// Whether two frames are the same place on screen. The list and the scroll view lay the hero out a pixel apart, so
    /// the control sits a third of a point differently in the two parts.
    private func samePlace(_ a: CGRect, _ b: CGRect) -> Bool {
        abs(a.minX - b.minX) <= 1 && abs(a.minY - b.minY) <= 1 && abs(a.width - b.width) <= 1 && abs(a.height - b.height) <= 1
    }

    /// Drags the list's content up by `points` and holds it there, so that it stops where the finger does instead of
    /// carrying on.
    @MainActor
    private func drag(upBy points: CGFloat, in app: XCUIApplication) {
        let start = app.windows.firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.7))
        start.press(forDuration: 0.1, thenDragTo: start.withOffset(CGVector(dx: 0, dy: -points)), withVelocity: .slow, thenHoldForDuration: 0.5)
    }

    /// Drags the list until `control`'s top edge is at `y`. A drag loses its first points to the touch slop, so it goes in
    /// steps, looking again after each.
    @MainActor
    private func drag(_ control: XCUIElement, to y: CGFloat, in app: XCUIApplication) {
        for _ in 0..<4 {
            settle(control)
            let remaining = control.frame.minY - y
            if abs(remaining) <= 4 { return }
            drag(upBy: remaining + (remaining > 0 ? 10 : -10), in: app)
        }
        settle(control)
    }

    /// Waits for `target` to keep its frame over three looks in a row.
    @MainActor
    private func settle(_ target: XCUIElement) {
        var previous: CGRect?
        var steady = 0
        _ = wait(timeout: patience) {
            let frame = target.frame
            steady = frame == previous ? steady + 1 : 0
            previous = frame
            return steady >= 3
        }
    }

    /// Scrolls the list until `target` lies between the bars: below the page's segmented control and above the tab bar. The
    /// bars are glass, so XCUITest counts a row under one as hittable, but a tap there lands on the bar.
    @MainActor
    private func scrollBetweenBars(_ target: XCUIElement, in app: XCUIApplication) {
        XCTAssertTrue(target.waitForExistence(timeout: patience), "the element to scroll to is not there\n\(app.debugDescription)")
        let parts = element("profile.parts", in: app)
        let top = max(app.navigationBars.firstMatch.frame.maxY, parts.frame.maxY) + 4
        let bottom = app.tabBars.firstMatch.exists ? app.tabBars.firstMatch.frame.minY : app.frame.maxY
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

    /// Empties the search field, which keeps the focus.
    @MainActor
    private func clearSearch(in app: XCUIApplication) {
        let search = app.searchFields.firstMatch
        let held = (search.value as? String)?.count ?? 0
        search.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: held))
    }

    /// Types at the end of a field: the tap lands at its right edge, past the text, so the caret does too.
    @MainActor
    private func append(_ text: String, to field: XCUIElement) {
        field.coordinate(withNormalizedOffset: CGVector(dx: 0.98, dy: 0.5)).tap()
        field.typeText(text)
    }

    /// Chooses a kind in the form's picker.
    @MainActor
    private func chooseKind(_ title: String, in app: XCUIApplication) {
        let picker = element("memory.form.kind", in: app)
        tapWhenSettled(picker, in: app)
        let item = app.buttons[title]
        XCTAssertTrue(item.waitForExistence(timeout: patience), "the picker does not offer \(title)\n\(app.debugDescription)")
        item.tap()
        XCTAssertTrue(wait(timeout: patience) { valueOrLabel(of: picker).contains(title) }, "the picker shows \(valueOrLabel(of: picker)), not \(title)")
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
            throw XCTSkip("ALFRED_PAIRING is not set: start scripts/app-dev.ts --seed-memories and pass its pairing to run this test")
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

/// The workbench API the app talks to, called with the device token from the pairing, as a second device would: the tests
/// use it to change memories behind the app's back.
private struct WorkbenchAPI {
    struct Failure: Error, CustomStringConvertible {
        let description: String
    }

    let server: URL
    let token: String

    init(environment: [String: String]) throws {
        let pairing = try XCTUnwrap(environment["ALFRED_PAIRING"])
        let object = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(pairing.utf8)) as? [String: Any])
        server = try XCTUnwrap((object["server"] as? String).flatMap(URL.init(string:)))
        token = try XCTUnwrap((object["device"] as? [String: Any])?["token"] as? String)
    }

    /// Replaces a memory's fields with the version it has now.
    func updateMemory(file: String, name: String, description: String, kind: String, body: String) throws {
        let memory = try current(file)
        _ = try call("POST", "/api/commands", body: [
            "type": "memory.update", "file": file, "version": memory["version"] as Any,
            "name": name, "description": description, "kind": kind, "body": body,
        ])
    }

    /// Adds a memory.
    func createMemory(name: String, description: String, kind: String, body: String) throws {
        _ = try call("POST", "/api/commands", body: [
            "type": "memory.create", "name": name, "description": description, "kind": kind, "body": body,
        ])
    }

    /// Deletes a memory at the version it has now.
    func deleteMemory(file: String) throws {
        let memory = try current(file)
        _ = try call("POST", "/api/commands", body: ["type": "memory.delete", "file": file, "version": memory["version"] as Any])
    }

    private func current(_ file: String) throws -> [String: Any] {
        let list = try XCTUnwrap(try JSONSerialization.jsonObject(with: call("GET", "/api/memories")) as? [String: Any])
        let memories = try XCTUnwrap(list["memories"] as? [[String: Any]])
        return try XCTUnwrap(memories.first { $0["file"] as? String == file }, "no memory \(file) on the server")
    }

    private func call(_ method: String, _ path: String, body: [String: Any]? = nil) throws -> Data {
        var request = URLRequest(url: server.appending(path: path))
        request.httpMethod = method
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        nonisolated(unsafe) var outcome: Result<Data, any Error> = .failure(Failure(description: "no answer"))
        let done = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: request) { data, response, error in
            defer { done.signal() }
            if let error {
                outcome = .failure(error)
            } else if let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) {
                outcome = .success(data ?? Data())
            } else {
                let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                outcome = .failure(Failure(description: "\(method) \(path): \(status) \(String(decoding: data ?? Data(), as: UTF8.self))"))
            }
        }.resume()
        XCTAssertEqual(done.wait(timeout: .now() + 30), .success, "\(method) \(path) did not answer")
        return try outcome.get()
    }
}
