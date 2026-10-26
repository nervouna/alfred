import XCTest

/// Pairs the app with a running `scripts/app-dev.ts` and chats with it. The pairing comes from the environment
/// variable `ALFRED_PAIRING` (pass `TEST_RUNNER_ALFRED_PAIRING` to xcodebuild); without it the test skips itself,
/// so CI and plain test runs need no stack. `/status` costs nothing, the second message runs the model.
final class ChatUITests: XCTestCase {
    /// How long to wait for the app or the server, which answers a command without a model. A server under load can
    /// take several seconds.
    private let patience: TimeInterval = 30
    /// How long to wait for a reply that needs a model call.
    private let modelPatience: TimeInterval = 120

    @MainActor
    func testPairThenChat() async throws {
        guard let pairing = ProcessInfo.processInfo.environment["ALFRED_PAIRING"], !pairing.isEmpty else {
            throw XCTSkip("ALFRED_PAIRING is not set: start scripts/app-dev.ts and pass its pairing to run this test")
        }
        continueAfterFailure = false

        let app = XCUIApplication()
        app.launch()
        unpairIfPaired(app)

        // The pairing goes in through the pasteboard, by the paste button that needs no paste prompt.
        UIPasteboard.general.string = pairing
        let paste = app.buttons["粘贴配对信息"]
        XCTAssertTrue(paste.waitForExistence(timeout: patience), "the pairing screen has no paste button\n\(app.debugDescription)")
        paste.tap()

        XCTAssertTrue(app.tabBars.buttons["对话"].waitForExistence(timeout: patience), "the chat tab did not appear\n\(app.debugDescription)")
        XCTAssertTrue(composer(in: app).waitForExistence(timeout: patience))

        // The stream replays what an earlier run left on the stack, and the list renders only what is near the
        // screen, so each step looks for a reply that was not there before it.
        XCTAssertTrue(app.staticTexts["连接中…"].waitForNonExistence(timeout: patience), "the stream never connected")
        waitUntilStable { messageIds(in: app).count }

        // A command: the reply comes from Alfred without a model call.
        let beforeStatus = messageIds(in: app)
        send("/status", in: app)
        let statusReply = newReply(beforeStatus, containing: "模型", in: app)
        XCTAssertTrue(statusReply.waitForExistence(timeout: patience), "no /status reply\n\(app.debugDescription)")

        // A message the model answers.
        let beforeAsk = messageIds(in: app)
        send("用一句话介绍你自己", in: app)
        let answer = newReply(beforeAsk, in: app)
        XCTAssertTrue(answer.waitForExistence(timeout: modelPatience), "Alfred did not answer\n\(app.debugDescription)")
        XCTAssertFalse(answer.label.isEmpty)
        XCTAssertTrue(app.buttons["停止"].waitForNonExistence(timeout: patience), "the stop button should go once the run ends")

        // Out of the app and back: what happened meanwhile is there once the stream resumes.
        let beforeBackground = messageIds(in: app)
        XCUIDevice.shared.press(.home)
        let marker = "/status " + UUID().uuidString.prefix(6).lowercased()
        let status = try await Self.sendFromOutside(marker, pairing: pairing)
        XCTAssertEqual(status, 202)
        sleep(2)
        app.activate()
        let echoed = app.staticTexts.matching(NSPredicate(format: "identifier BEGINSWITH 'message.in.' AND label == %@", marker)).firstMatch
        XCTAssertTrue(echoed.waitForExistence(timeout: patience), "the stream did not resume with what happened in the background\n\(app.debugDescription)")
        let missed = newReply(beforeBackground, containing: "模型", in: app)
        XCTAssertTrue(missed.waitForExistence(timeout: patience), "the reply to the message sent in the background is missing")
    }

    /// The attach button offers photos and files, and is the way to the pickers.
    @MainActor
    func testTheAttachMenuOffersPhotosAndFiles() throws {
        guard let pairing = ProcessInfo.processInfo.environment["ALFRED_PAIRING"], !pairing.isEmpty else {
            throw XCTSkip("ALFRED_PAIRING is not set: start scripts/app-dev.ts and pass its pairing to run this test")
        }
        continueAfterFailure = false

        let app = XCUIApplication()
        app.launch()
        unpairIfPaired(app)
        UIPasteboard.general.string = pairing
        app.buttons["粘贴配对信息"].tap()
        XCTAssertTrue(composer(in: app).waitForExistence(timeout: patience), "the chat did not appear\n\(app.debugDescription)")

        let attach = app.buttons["添加附件"]
        XCTAssertTrue(attach.waitForExistence(timeout: patience))
        attach.tap()
        XCTAssertTrue(app.buttons["照片"].waitForExistence(timeout: patience), "no 照片 in the attach menu\n\(app.debugDescription)")
        XCTAssertTrue(app.buttons["文件"].exists, "no 文件 in the attach menu\n\(app.debugDescription)")
        // Nothing is chosen, so nothing is attached and the send button stays off.
        XCTAssertEqual(app.otherElements.matching(identifier: "attachment.chip").count, 0)
    }

    /// Sends a message to Alfred as the paired device, without the app: the device token in `pairing` is the
    /// app's own.
    private static func sendFromOutside(_ text: String, pairing: String) async throws -> Int? {
        let open = try XCTUnwrap(pairing.firstIndex(of: "{"))
        let close = try XCTUnwrap(pairing.lastIndex(of: "}"))
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(pairing[open...close].utf8)) as? [String: Any])
        let server = try XCTUnwrap(object["server"] as? String)
        let access = try XCTUnwrap(object["access"] as? [String: String])
        let device = try XCTUnwrap(object["device"] as? [String: String])
        var request = URLRequest(url: try XCTUnwrap(URL(string: server + "/api/commands")))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(access["clientId"], forHTTPHeaderField: "CF-Access-Client-Id")
        request.setValue(access["clientSecret"], forHTTPHeaderField: "CF-Access-Client-Secret")
        request.setValue("Bearer " + (device["token"] ?? ""), forHTTPHeaderField: "Authorization")
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "type": "message.send", "clientId": "uitest-" + UUID().uuidString.lowercased(), "text": text,
        ])
        let (_, response) = try await URLSession.shared.data(for: request)
        return (response as? HTTPURLResponse)?.statusCode
    }

    /// A pairing whose device token the server does not know leaves the app on the pairing screen, with the reason.
    @MainActor
    func testARefusedDeviceStaysOnThePairingScreen() throws {
        guard let pairing = ProcessInfo.processInfo.environment["ALFRED_PAIRING"], !pairing.isEmpty else {
            throw XCTSkip("ALFRED_PAIRING is not set: start scripts/app-dev.ts and pass its pairing to run this test")
        }
        let token = try XCTUnwrap(pairing.range(of: #""token":"[^"]+""#, options: .regularExpression))
        let refused = pairing.replacingCharacters(in: token, with: #""token":"NOT-A-DEVICE-TOKEN""#)

        let app = XCUIApplication()
        app.launch()
        unpairIfPaired(app)

        UIPasteboard.general.string = refused
        app.buttons["粘贴配对信息"].tap()
        let reason = app.staticTexts["pairing.error"]
        XCTAssertTrue(reason.waitForExistence(timeout: patience), "no reason on the pairing screen\n\(app.debugDescription)")
        XCTAssertTrue(reason.label.contains("拒绝"), reason.label)
        XCTAssertFalse(app.tabBars.buttons["对话"].exists)
        XCTAssertTrue(app.buttons["粘贴配对信息"].exists)
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
            app.buttons["更多"].tap()
            app.buttons["取消配对"].tap()
            // The confirmation repeats the menu item's name.
            app.buttons["取消配对"].firstMatch.tap()
        }
        XCTAssertTrue(paste.waitForExistence(timeout: patience), "the app did not return to pairing\n\(app.debugDescription)")
    }

    @MainActor
    private func composer(in app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: "composer").firstMatch
    }

    @MainActor
    private func send(_ text: String, in app: XCUIApplication) {
        let field = composer(in: app)
        field.tap()
        field.typeText(text)
        app.buttons["发送"].tap()
    }

    /// Returns once `value` has stayed the same for a second, which is when the replay of old events is over.
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
}
