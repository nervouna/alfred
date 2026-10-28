import XCTest

/// Pairs the app with a running `scripts/app-dev.ts` and scrolls the chat: a round button above the composer returns to the
/// newest message while the list is scrolled up, and content that arrives then leaves the list where it is. It runs no model
/// (`/status` is answered by Alfred itself). The pairing comes from the environment variable `ALFRED_PAIRING` (pass
/// `TEST_RUNNER_ALFRED_PAIRING` to xcodebuild); without it the tests skip themselves.
///
/// Each test first sends `/status` eight times as the paired device, before the app starts, so the conversation is several
/// screens tall and the app opens on a backlog.
final class ChatScrollUITests: XCTestCase {
    private let patience: TimeInterval = 30
    /// How many `/status` the conversation is given.
    private let backlog = 8

    @MainActor
    func testTheLatestButtonAppearsAboveTheComposerAndReturnsToTheEnd() async throws {
        let (app, seen, _) = try await launchPaired()
        let latest = element("chat.latest", in: app)
        let composer = element("composer", in: app)
        let newest = element("message.out." + seen.reply, in: app)

        // The list opens on the newest message, and the button is not there.
        XCTAssertTrue(newest.waitForExistence(timeout: patience), "the newest message is not on screen\n\(app.debugDescription)")
        XCTAssertFalse(latest.exists, "the button shows while the list is at its end\n\(app.debugDescription)")

        scrollUp(in: app)
        XCTAssertTrue(latest.waitForExistence(timeout: patience), "no button after scrolling up\n\(app.debugDescription)")
        XCTAssertEqual(latest.frame.midX, app.frame.midX, accuracy: 2, "the button is not centred: \(latest.frame)")
        XCTAssertLessThanOrEqual(latest.frame.maxY, composer.frame.minY, "the button is not above the composer: \(latest.frame), \(composer.frame)")
        XCTAssertEqual(latest.frame.width, 44, accuracy: 1, "the button is not 44 pt wide: \(latest.frame)")
        XCTAssertEqual(latest.frame.height, 44, accuracy: 1, "the button is not 44 pt tall: \(latest.frame)")
        XCTAssertEqual(latest.label, "回到最新")

        // It returns to the newest message, and goes.
        tapWhenSettled(latest, in: app)
        XCTAssertTrue(
            wait(timeout: patience) { newest.exists && newest.isHittable && newest.frame.maxY <= composer.frame.minY },
            "the newest message did not come into view\n\(app.debugDescription)"
        )
        XCTAssertTrue(latest.waitForNonExistence(timeout: patience), "the button stayed after the list returned to its end\n\(app.debugDescription)")
    }

    @MainActor
    func testAMessageArrivingWhileScrolledUpLeavesTheListWhereItIs() async throws {
        let (app, _, pairing) = try await launchPaired()
        let latest = element("chat.latest", in: app)
        let composer = element("composer", in: app)

        scrollUp(in: app)
        XCTAssertTrue(latest.waitForExistence(timeout: patience), "no button after scrolling up\n\(app.debugDescription)")
        let shown = restingHittableMessageIds(in: app)
        XCTAssertFalse(shown.isEmpty, "no message is on screen after scrolling up\n\(app.debugDescription)")

        // A message the app did not send, answered by Alfred.
        let arrived = try await Outside.status(count: 1, pairing: pairing, patience: patience)
        sleep(5)
        XCTAssertTrue(latest.exists, "the button went when a message arrived\n\(app.debugDescription)")
        for identifier in shown {
            XCTAssertTrue(app.staticTexts[identifier].isHittable, "\(identifier) moved when a message arrived\n\(app.debugDescription)")
        }

        // The button leads to it.
        tapWhenSettled(latest, in: app)
        let reply = element("message.out." + arrived.reply, in: app)
        XCTAssertTrue(
            wait(timeout: patience) { reply.exists && reply.isHittable && reply.frame.maxY <= composer.frame.minY },
            "the new reply did not come into view\n\(app.debugDescription)"
        )
        XCTAssertTrue(latest.waitForNonExistence(timeout: patience), "the button stayed after the list returned to its end\n\(app.debugDescription)")
    }

    @MainActor
    func testSendingFromTheComposerGoesToTheEnd() async throws {
        let (app, seen, _) = try await launchPaired()
        let latest = element("chat.latest", in: app)
        let composer = element("composer", in: app)

        scrollUp(in: app)
        XCTAssertTrue(latest.waitForExistence(timeout: patience), "no button after scrolling up\n\(app.debugDescription)")

        composer.tap()
        composer.typeText("/status")
        app.buttons["发送"].tap()

        let known = seen.messageIds.flatMap { ["message.in." + $0, "message.out." + $0] }
        let reply = app.staticTexts.matching(NSPredicate(format: "identifier BEGINSWITH 'message.out.' AND NOT (identifier IN %@)", known)).firstMatch
        XCTAssertTrue(reply.waitForExistence(timeout: patience), "no reply to the message sent\n\(app.debugDescription)")
        XCTAssertTrue(
            wait(timeout: patience) { reply.isHittable && reply.frame.maxY <= composer.frame.minY },
            "the reply is not in view: \(reply.identifier) \(reply.frame), hittable \(reply.isHittable), composer \(composer.frame)\n\(app.debugDescription)"
        )
        XCTAssertTrue(latest.waitForNonExistence(timeout: patience), "the button stayed after the owner sent a message\n\(app.debugDescription)")
    }

    // MARK: The list

    /// Swipes the list towards its older messages, a few screens' worth.
    @MainActor
    private func scrollUp(in app: XCUIApplication) {
        let list = app.scrollViews.firstMatch
        XCTAssertTrue(list.waitForExistence(timeout: patience), "no list\n\(app.debugDescription)")
        for _ in 0..<3 {
            list.swipeDown()
        }
    }

    /// The identifiers of the stored messages on screen, once they stay the same for a second, which is when the list has
    /// stopped moving.
    @MainActor
    private func restingHittableMessageIds(in app: XCUIApplication) -> [String] {
        var last = hittableMessageIds(in: app)
        var steady = 0
        let deadline = Date().addingTimeInterval(patience)
        while steady < 4, Date() < deadline {
            usleep(250_000)
            let now = hittableMessageIds(in: app)
            steady = now == last ? steady + 1 : 0
            last = now
        }
        return last
    }

    /// The identifiers of the stored messages the user can touch: `message.in.<id>` or `message.out.<id>`.
    @MainActor
    private func hittableMessageIds(in app: XCUIApplication) -> [String] {
        app.staticTexts.matching(NSPredicate(format: "identifier BEGINSWITH 'message.'"))
            .allElementsBoundByIndex
            .filter { ($0.identifier.hasPrefix("message.in.") || $0.identifier.hasPrefix("message.out.")) && $0.isHittable }
            .map(\.identifier)
            .sorted()
    }

    /// Taps `target` once its frame has held still while it was hittable. A tap computed while the button is still
    /// appearing or the keyboard still moving lands elsewhere.
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

    // MARK: Pairing

    /// Gives the conversation its backlog, launches the app, pairs it with the stack from the environment, and returns once
    /// the chat is connected and shows the newest message. `seen` is what the server held after the last `/status`.
    @MainActor
    private func launchPaired() async throws -> (app: XCUIApplication, seen: Outside.Seen, pairing: String) {
        guard let pairing = ProcessInfo.processInfo.environment["ALFRED_PAIRING"], !pairing.isEmpty else {
            throw XCTSkip("ALFRED_PAIRING is not set: start scripts/app-dev.ts and pass its pairing to run this test")
        }
        continueAfterFailure = false

        let seen = try await Outside.status(count: backlog, pairing: pairing, patience: patience)

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
        // The backlog is replayed after the stream connects, and the list renders only what is near the screen.
        XCTAssertTrue(
            element("message.out." + seen.reply, in: app).waitForExistence(timeout: patience * 2),
            "the newest message did not arrive\n\(app.debugDescription)"
        )
        return (app, seen, pairing)
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

/// The server's side of the conversation, reached the way the paired device reaches it but without the app: the device
/// token in the pairing is the app's own.
private enum Outside {
    struct Seen: Sendable {
        /// The id of Alfred's reply to the last message sent, which is the newest message.
        let reply: String
        /// The ids of every message the server holds, the owner's and Alfred's.
        let messageIds: Set<String>
    }

    struct Failure: Error, CustomStringConvertible {
        let description: String
    }

    /// Sends `/status` as the paired device `count` times, one after the other, and returns once the server has stored Alfred's
    /// reply to the last. Alfred answers it itself, with no model call.
    static func status(count: Int, pairing: String, patience: TimeInterval) async throws -> Seen {
        let configuration = URLSessionConfiguration.ephemeral
        // A stack on a busy machine can take a while to answer, and the stream is silent until it does.
        configuration.timeoutIntervalForRequest = patience * 3
        let session = URLSession(configuration: configuration)
        // Ends the stream when the last reply is found.
        defer { session.invalidateAndCancel() }

        // The stream replays everything from the start, then follows. One stream serves every message.
        let (bytes, opened) = try await session.bytes(for: try request("/api/events", method: "GET", pairing: pairing))
        guard (opened as? HTTPURLResponse)?.statusCode == 200 else { throw Failure(description: "the event stream answered \(opened)") }
        var lines = bytes.lines.makeAsyncIterator()
        var ids = Set<String>()
        var reply: String?
        for _ in 0..<count {
            let clientId = "uitest-" + UUID().uuidString.lowercased()
            let send = try request("/api/commands", method: "POST", pairing: pairing, body: ["type": "message.send", "clientId": clientId, "text": "/status"])
            let (_, sent) = try await session.data(for: send)
            guard (sent as? HTTPURLResponse)?.statusCode == 202 else { throw Failure(description: "the message was answered \(sent)") }

            // The message is stored under the client id; the next message from Alfred after it is the answer.
            var storedAt: Int?
            var answered = false
            while !answered {
                guard let line = try await lines.next() else { throw Failure(description: "the event stream ended before Alfred answered") }
                guard line.hasPrefix("data: "),
                      let object = try? JSONSerialization.jsonObject(with: Data(line.dropFirst(6).utf8)) as? [String: Any],
                      object["type"] as? String == "message.created",
                      let eventId = object["id"] as? Int,
                      let message = object["data"] as? [String: Any],
                      let id = message["id"] as? String
                else { continue }
                ids.insert(id)
                if let stored = storedAt {
                    if message["direction"] as? String == "out", eventId > stored {
                        reply = id
                        answered = true
                    }
                } else if message["direction"] as? String == "in", message["clientId"] as? String == clientId {
                    storedAt = eventId
                }
            }
        }
        return Seen(reply: try XCTUnwrap(reply), messageIds: ids)
    }

    private static func request(_ path: String, method: String, pairing: String, body: [String: Any]? = nil) throws -> URLRequest {
        let open = try XCTUnwrap(pairing.firstIndex(of: "{"))
        let close = try XCTUnwrap(pairing.lastIndex(of: "}"))
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(pairing[open...close].utf8)) as? [String: Any])
        let server = try XCTUnwrap(object["server"] as? String)
        let access = try XCTUnwrap(object["access"] as? [String: String])
        let device = try XCTUnwrap(object["device"] as? [String: String])
        var request = URLRequest(url: try XCTUnwrap(URL(string: server + path)))
        request.httpMethod = method
        request.setValue(access["clientId"], forHTTPHeaderField: "CF-Access-Client-Id")
        request.setValue(access["clientSecret"], forHTTPHeaderField: "CF-Access-Client-Secret")
        request.setValue("Bearer " + (device["token"] ?? ""), forHTTPHeaderField: "Authorization")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        return request
    }
}
