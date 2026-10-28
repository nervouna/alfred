import XCTest

/// Delivers notifications to a paired app the way the server does and checks what the app does with them. The test runs
/// inside the simulator and cannot call `xcrun simctl push`, so a driver outside it pushes (see the iOS README): whenever
/// the test writes `ready-<n>` into the directory named by `ALFRED_PUSH_DIR`, the driver pushes `payload.json` from
/// that directory to the app. The test writes `payload.json` itself, with the event id of a message in the chat.
///
/// Like the other UI tests it needs a running `scripts/app-dev.ts` (`ALFRED_PAIRING`) and skips itself without one.
@MainActor
final class PushUITests: XCTestCase {
    private let patience: TimeInterval = 30
    private let bannerText = "UI test push"
    private let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")

    /// With the chat on screen a notification shows nothing; on another tab it shows a banner; and one that arrives
    /// while the app is in the background, tapped, opens the chat at the message it names.
    func testNotificationsFollowTheForegroundRuleAndATapOpensTheChatAtItsMessage() async throws {
        let environment = ProcessInfo.processInfo.environment
        guard let pairing = environment["ALFRED_PAIRING"], !pairing.isEmpty,
              let handshake = environment["ALFRED_PUSH_DIR"], !handshake.isEmpty
        else {
            throw XCTSkip("ALFRED_PAIRING and ALFRED_PUSH_DIR are not set: see the iOS README for the push check")
        }
        continueAfterFailure = false

        let app = XCUIApplication()
        app.launch()
        unpairIfPaired(app)
        UIPasteboard.general.string = pairing
        app.buttons["粘贴配对信息"].tap()
        XCTAssertTrue(app.tabBars.buttons["对话"].waitForExistence(timeout: patience), "the chat tab did not appear\n\(app.debugDescription)")
        allowNotifications(waiting: 5)
        XCTAssertTrue(app.staticTexts["连接中…"].waitForNonExistence(timeout: patience), "the stream never connected")
        waitUntilStable { messageIds(in: app).count }

        // Enough replies that the first one is far above the screen. `/status` costs nothing.
        let before = messageIds(in: app)
        send("/status", in: app)
        let first = newReply(before, in: app)
        XCTAssertTrue(first.waitForExistence(timeout: patience), "no /status reply\n\(app.debugDescription)")
        let firstId = first.identifier
        for _ in 0..<7 {
            let known = messageIds(in: app)
            send("/status", in: app)
            XCTAssertTrue(newReply(known, in: app).waitForExistence(timeout: patience), "no /status reply\n\(app.debugDescription)")
        }
        XCTAssertFalse(isOnScreen(element(firstId, in: app), in: app), "the first reply should be scrolled out of sight")

        // The payload is shaped like the workbench's, naming the first reply.
        let eventId = try await eventId(ofMessage: String(firstId.dropFirst("message.out.".count)), pairing: pairing)
        let payload: [String: Any] = [
            "aps": ["alert": ["title": "Alfred", "body": bannerText], "sound": "default", "thread-id": "chat"],
            "eventId": eventId,
        ]
        try JSONSerialization.data(withJSONObject: payload).write(to: URL(filePath: handshake).appending(path: "payload.json"))

        // The chat is on screen: the notification arrives and shows nothing. The system's question may come late on a
        // new simulator, and an unanswered question means no notification at all.
        allowNotifications(waiting: 15)
        dismissKeyboard(in: app)
        push(1, handshake)
        XCTAssertFalse(banner().waitForExistence(timeout: 8), "a notification was shown over the chat\n\(springboard.debugDescription)")

        // Another tab is on screen: the notification shows as a banner.
        app.tabBars.buttons["任务"].tap()
        push(2, handshake)
        XCTAssertTrue(banner().waitForExistence(timeout: patience), "no banner over the tasks tab\n\(springboard.debugDescription)")
        XCTAssertTrue(banner().waitForNonExistence(timeout: patience), "the banner stayed")

        // The app is in the background: the notification is shown by the system, and tapping it opens the chat at the
        // message. The tap switches tabs, which makes a new list, and a list that is still laying out can lose a scroll
        // made at once; that is a matter of timing, so the tap is made three times.
        for round in 0..<3 {
            if round > 0 { app.tabBars.buttons["任务"].tap() }
            XCUIDevice.shared.press(.home)
            push(3 + round, handshake)
            let tapped = banner()
            XCTAssertTrue(tapped.waitForExistence(timeout: patience), "no banner on the home screen (tap \(round + 1))\n\(springboard.debugDescription)")
            tapped.tap()

            XCTAssertTrue(app.wait(for: .runningForeground, timeout: patience), "the app did not come to the foreground (tap \(round + 1))")
            XCTAssertTrue(app.tabBars.buttons["对话"].isSelected, "the chat tab is not selected (tap \(round + 1))\n\(app.debugDescription)")
            let reply = element(firstId, in: app)
            XCTAssertTrue(wait(timeout: patience) { isOnScreen(reply, in: app) }, "the chat did not scroll to the message (tap \(round + 1))\n\(app.debugDescription)")
        }

        FileManager.default.createFile(atPath: URL(filePath: handshake).appending(path: "done").path, contents: nil)
    }

    // MARK: The driver

    /// Asks the driver for push number `n`.
    private func push(_ n: Int, _ handshake: String) {
        FileManager.default.createFile(atPath: URL(filePath: handshake).appending(path: "ready-\(n)").path, contents: nil)
    }

    /// The banner for the test's notification, on the home screen or over an app.
    private func banner() -> XCUIElement {
        springboard.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", bannerText)).firstMatch
    }

    /// Answers the system's question about notifications, if it is asked: it is asked once per install.
    private func allowNotifications(waiting seconds: TimeInterval) {
        let alert = springboard.alerts.firstMatch
        guard alert.waitForExistence(timeout: seconds) else { return }
        let allow = alert.buttons.matching(NSPredicate(format: "label IN {'Allow', '允许'}")).firstMatch
        XCTAssertTrue(allow.exists, "the notification question has no Allow button\n\(springboard.debugDescription)")
        allow.tap()
        XCTAssertTrue(alert.waitForNonExistence(timeout: patience))
    }

    /// The id of the event that stored the message `messageId`, read from the event stream as the app reads it.
    private func eventId(ofMessage messageId: String, pairing: String) async throws -> Int {
        let open = try XCTUnwrap(pairing.firstIndex(of: "{"))
        let close = try XCTUnwrap(pairing.lastIndex(of: "}"))
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(pairing[open...close].utf8)) as? [String: Any])
        let server = try XCTUnwrap(object["server"] as? String)
        let access = try XCTUnwrap(object["access"] as? [String: String])
        let device = try XCTUnwrap(object["device"] as? [String: String])
        var request = URLRequest(url: try XCTUnwrap(URL(string: server + "/api/events")))
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        request.setValue("0", forHTTPHeaderField: "Last-Event-ID")
        request.setValue(access["clientId"], forHTTPHeaderField: "CF-Access-Client-Id")
        request.setValue(access["clientSecret"], forHTTPHeaderField: "CF-Access-Client-Secret")
        request.setValue("Bearer " + (device["token"] ?? ""), forHTTPHeaderField: "Authorization")
        let (bytes, _) = try await URLSession.shared.bytes(for: request)
        var id: Int?
        for try await line in bytes.lines {
            if line.hasPrefix("id: ") {
                id = Int(line.dropFirst(4))
            } else if line.hasPrefix("data: "), let id,
                      let event = try? JSONSerialization.jsonObject(with: Data(line.dropFirst(6).utf8)) as? [String: Any],
                      event["type"] as? String == "message.created",
                      (event["data"] as? [String: Any])?["id"] as? String == messageId {
                return id
            }
        }
        throw XCTSkip("the stream has no message \(messageId)")
    }

    // MARK: The app

    private func isOnScreen(_ element: XCUIElement, in app: XCUIApplication) -> Bool {
        element.exists && element.isHittable && app.windows.firstMatch.frame.intersects(element.frame)
    }

    private func dismissKeyboard(in app: XCUIApplication) {
        // The first drag on a new simulator can miss, so it is tried again.
        for _ in 0..<3 where app.keyboards.count > 0 {
            let top = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.25))
            let bottom = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.98))
            top.press(forDuration: 0.1, thenDragTo: bottom)
            if app.keyboards.firstMatch.waitForNonExistence(timeout: 5) { return }
        }
        XCTAssertEqual(app.keyboards.count, 0, "the keyboard stayed up")
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

    private func send(_ text: String, in app: XCUIApplication) {
        let field = element("composer", in: app)
        field.tap()
        field.typeText(text)
        app.buttons["发送"].tap()
    }

    private func element(_ identifier: String, in app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: identifier).firstMatch
    }

    /// The identifiers of the stored messages on screen: `message.in.<id>` or `message.out.<id>`.
    private func messageIds(in app: XCUIApplication) -> [String] {
        app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'message.'"))
            .allElementsBoundByIndex.map(\.identifier)
            .filter { $0.hasPrefix("message.in.") || $0.hasPrefix("message.out.") }
    }

    /// A stored message from Alfred that is not among `known`.
    private func newReply(_ known: [String], in app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'message.out.' AND NOT (identifier IN %@)", known)).firstMatch
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
