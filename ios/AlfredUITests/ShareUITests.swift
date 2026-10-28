import XCTest

/// Shares a photo from the Photos app to Alfred through the Share Extension, against a running `scripts/app-dev.ts`
/// (`ALFRED_PAIRING`; the tests skip themselves without it). The simulator needs a photo in its library:
/// `xcrun simctl addmedia <udid> <image>`. The extension reads the app's pairing from the keychain, so the app pairs
/// first, except in the test of the case without a pairing. The message goes to the model, which costs a fraction of
/// a cent.
///
/// The Photos app is not ours: the test finds its controls by identifier where it can, and only the first-run
/// "Continue" button is found by its name.
@MainActor
final class ShareUITests: XCTestCase {
    private let patience: TimeInterval = 30

    func testAPhotoSharedFromPhotosArrivesAsAMessageWithItsFile() throws {
        guard let pairing = ProcessInfo.processInfo.environment["ALFRED_PAIRING"], !pairing.isEmpty else {
            throw XCTSkip("ALFRED_PAIRING is not set: start scripts/app-dev.ts and pass its pairing to run this test")
        }
        continueAfterFailure = false

        let app = XCUIApplication()
        app.launch()
        unpairIfPaired(app)
        UIPasteboard.general.string = pairing
        app.buttons["粘贴配对信息"].tap()
        XCTAssertTrue(app.tabBars.buttons["对话"].waitForExistence(timeout: patience), "the chat tab did not appear\n\(app.debugDescription)")
        XCTAssertTrue(app.staticTexts["连接中…"].waitForNonExistence(timeout: patience), "the stream never connected")
        waitUntilStable { messageIds(in: app).count }
        let knownChips = Set(fileChipIds(in: app))

        // The newest photo, shared to Alfred.
        let photos = try openShareSheetForTheNewestPhoto()

        // The sheet shows the image and a note field; the note goes with the file.
        let note = photos.textFields["share.note"]
        XCTAssertTrue(note.waitForExistence(timeout: patience), "the share sheet did not load the image\n\(photos.debugDescription)")
        let marker = "分享测试 " + UUID().uuidString.prefix(6).lowercased()
        note.tap()
        note.typeText(marker)
        let send = photos.buttons["share.send"]
        XCTAssertTrue(send.isEnabled)
        send.tap()
        XCTAssertTrue(send.waitForNonExistence(timeout: patience), "the share sheet did not close\n\(photos.debugDescription)")

        // In the app the message is there once the stream has it, with the file.
        app.activate()
        let message = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'message.in.' AND label == %@", marker)).firstMatch
        XCTAssertTrue(message.waitForExistence(timeout: patience), "the shared message did not arrive\n\(app.debugDescription)")
        XCTAssertTrue(wait(timeout: patience) { fileChipIds(in: app).contains { !knownChips.contains($0) && $0.hasPrefix("file.chip.inbox/") } },
                      "the message has no file\n\(app.debugDescription)")
    }

    /// Without a pairing the sheet says to pair first, and closes.
    func testWithoutAPairingTheSheetAsksToPairFirst() throws {
        guard let pairing = ProcessInfo.processInfo.environment["ALFRED_PAIRING"], !pairing.isEmpty else {
            throw XCTSkip("ALFRED_PAIRING is not set: start scripts/app-dev.ts and pass its pairing to run this test")
        }
        continueAfterFailure = false

        let app = XCUIApplication()
        app.launch()
        unpairIfPaired(app)

        let photos = try openShareSheetForTheNewestPhoto()
        let text = photos.staticTexts["share.needsPairing"]
        XCTAssertTrue(text.waitForExistence(timeout: patience), "the sheet did not ask to pair\n\(photos.debugDescription)")
        XCTAssertEqual(text.label, "请先在 Alfred 里完成配对")
        XCTAssertFalse(photos.buttons["share.send"].exists, "there is nothing to send")
        let close = photos.buttons["share.cancel"]
        XCTAssertEqual(close.label, "关闭")
        close.tap()
        XCTAssertTrue(close.waitForNonExistence(timeout: patience), "the sheet did not close\n\(photos.debugDescription)")
    }

    // MARK: Photos

    /// Opens the share sheet of the newest photo in the Photos app and taps Alfred in it. Returns the Photos app, which
    /// hosts the extension's sheet.
    private func openShareSheetForTheNewestPhoto() throws -> XCUIApplication {
        let photos = XCUIApplication(bundleIdentifier: "com.apple.mobileslideshow")
        photos.launch()
        let proceed = photos.buttons.matching(NSPredicate(format: "label IN {'Continue', '继续'}")).firstMatch
        if proceed.waitForExistence(timeout: 8) { proceed.tap() }
        // Photos resumes where it was left: on a photo opened by an earlier run, or on the library.
        let share = photos.buttons["PUOneUpBarButtonItemIdentifierShare"]
        if !share.waitForExistence(timeout: 5) {
            let grid = photos.images.matching(identifier: "PXGGridLayout-Info")
            guard grid.firstMatch.waitForExistence(timeout: patience) else {
                throw XCTSkip("the Photos library is empty: run xcrun simctl addmedia <udid> <image>")
            }
            grid.allElementsBoundByIndex.last?.tap()
        }
        XCTAssertTrue(share.waitForExistence(timeout: patience), "no share button\n\(photos.debugDescription)")
        share.tap()
        let alfred = photos.cells.matching(identifier: "shareCell").matching(NSPredicate(format: "label == 'Alfred'")).firstMatch
        XCTAssertTrue(alfred.waitForExistence(timeout: patience), "Alfred is not in the share sheet\n\(photos.debugDescription)")
        alfred.tap()
        return photos
    }

    // MARK: The app

    /// The identifiers of the file chips on screen.
    private func fileChipIds(in app: XCUIApplication) -> [String] {
        app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'file.chip.'"))
            .allElementsBoundByIndex.map(\.identifier)
    }

    /// The identifiers of the stored messages on screen: `message.in.<id>` or `message.out.<id>`.
    private func messageIds(in app: XCUIApplication) -> [String] {
        app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'message.'"))
            .allElementsBoundByIndex.map(\.identifier)
            .filter { $0.hasPrefix("message.in.") || $0.hasPrefix("message.out.") }
    }

    /// Leaves the app on the pairing screen: a paired app unpairs through the menu, and one whose device the
    /// server no longer knows (the stack was restarted) pairs again from the failure screen.
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

    /// Polls `condition` until it holds or `timeout` passes.
    private func wait(timeout: TimeInterval, until condition: () -> Bool) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return true }
            usleep(250_000)
        }
        return condition()
    }

    /// Returns once `value` has stayed the same for a second.
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
