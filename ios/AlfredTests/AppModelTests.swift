import AlfredKit
import XCTest

@testable import Alfred

@MainActor
final class AppModelTests: XCTestCase {
    /// A model on a fake server. `replies` answers a path with its next reply; an event stream that stays open is the
    /// default for `/api/events`, `204` for `/api/ping` and `202` for `/api/commands`.
    private func makeModel(
        credentials paired: Bool = false,
        replies: [String: [StubReply]] = [:]
    ) throws -> (AppModel, StubServer, InMemoryCredentialStore) {
        let scripts = replies.mapValues(ReplyScript.init)
        let server = StubServer { request in
            let path = request.url?.path ?? ""
            if let script = scripts[path] { return script.next() }
            switch path {
            case "/api/ping": return StubReply(status: 204)
            case "/api/commands": return StubReply(status: 202)
            case "/api/events": return .stream()
            default: return StubReply(status: 404)
            }
        }
        let store = InMemoryCredentialStore(paired ? try server.credentials() : nil)
        var counter = 0
        let model = AppModel(store: store, session: server.session) {
            counter += 1
            return "c-test-\(counter)"
        }
        // The server unregisters its handler when it goes, so it stays until the test is over.
        addTeardownBlock { @MainActor in
            model.background()
            withExtendedLifetime(server) {}
        }
        return (model, server, store)
    }

    // MARK: Pairing

    func testPairingSucceedsAndSavesTheCredentials() async throws {
        let (model, server, store) = try makeModel()
        XCTAssertFalse(model.isPaired)

        await model.pair(with: server.pairingJSON)

        XCTAssertNil(model.pairingFailure)
        XCTAssertTrue(model.isPaired)
        let expected = try server.credentials()
        XCTAssertEqual(try store.load(), expected)
        XCTAssertEqual(model.credentials, expected)
        let ping = try XCTUnwrap(server.requests(to: "/api/ping").first)
        XCTAssertEqual(ping.request.value(forHTTPHeaderField: "Authorization"), "Bearer EXAMPLE-DEVICE-TOKEN-NOT-REAL-0123456789abc")
        XCTAssertEqual(ping.request.value(forHTTPHeaderField: "CF-Access-Client-Id"), "example-service-token.access")
    }

    func testPairingAcceptsTheLineAppDevPrints() async throws {
        let (model, server, store) = try makeModel()
        await model.pair(with: "[pairing] " + server.pairingJSON + "\n")
        XCTAssertTrue(model.isPaired)
        XCTAssertNotNil(try store.load())
    }

    func testARefusedDeviceLeavesNoCredentials() async throws {
        let (model, server, store) = try makeModel(replies: ["/api/ping": [StubReply(status: 401)]])
        await model.pair(with: server.pairingJSON)

        XCTAssertEqual(model.pairingFailure, .deviceRefused)
        XCTAssertFalse(model.isPaired)
        XCTAssertNil(try store.load())
    }

    func testRefusedAccessLeavesNoCredentials() async throws {
        let (model, server, store) = try makeModel(replies: ["/api/ping": [StubReply(status: 403)]])
        await model.pair(with: server.pairingJSON)

        XCTAssertEqual(model.pairingFailure, .accessRefused)
        XCTAssertNil(try store.load())
    }

    func testANetworkErrorLeavesNoCredentials() async throws {
        let (model, server, store) = try makeModel(replies: ["/api/ping": [StubReply(failure: .notConnectedToInternet)]])
        await model.pair(with: server.pairingJSON)

        guard case .network = model.pairingFailure else {
            return XCTFail("expected a network failure, got \(String(describing: model.pairingFailure))")
        }
        XCTAssertNil(try store.load())
    }

    func testAnUnexpectedStatusIsReported() async throws {
        let (model, server, _) = try makeModel(replies: ["/api/ping": [StubReply(status: 502)]])
        await model.pair(with: server.pairingJSON)
        XCTAssertEqual(model.pairingFailure, .server(status: 502))
    }

    func testAnInvalidCodeGivesItsErrorWithoutAnyRequest() async throws {
        let (model, server, store) = try makeModel()
        for code in [
            "hello",
            "",
            "{}",
            #"{"version":2,"server":"https://alfred.example.com","access":{"clientId":"a","clientSecret":"b"},"device":{"id":"c","token":"d"}}"#,
            #"{"version":1,"server":"http://192.168.1.2:8787","access":{"clientId":"a","clientSecret":"b"},"device":{"id":"c","token":"d"}}"#,
        ] {
            await model.pair(with: code)
            XCTAssertEqual(model.pairingFailure, .invalidCode, code)
        }
        XCTAssertNil(try store.load())
        XCTAssertTrue(server.log.isEmpty)
    }

    func testAnewAttemptClearsTheLastFailure() async throws {
        let (model, server, _) = try makeModel(replies: ["/api/ping": [StubReply(status: 401), StubReply(status: 204)]])
        await model.pair(with: server.pairingJSON)
        XCTAssertNotNil(model.pairingFailure)
        await model.pair(with: server.pairingJSON)
        XCTAssertNil(model.pairingFailure)
        XCTAssertTrue(model.isPaired)
    }

    func testAKeychainThatCannotSaveFailsThePairing() async throws {
        struct FailingStore: CredentialStore {
            struct Refused: Error {}
            func load() throws -> Credentials? { nil }
            func save(_ credentials: Credentials) throws { throw Refused() }
            func delete() throws {}
        }
        let server = StubServer { _ in StubReply(status: 204) }
        let model = AppModel(store: FailingStore(), session: server.session)
        await model.pair(with: server.pairingJSON)
        XCTAssertEqual(model.pairingFailure, .storage)
        XCTAssertFalse(model.isPaired)
    }

    func testStoredCredentialsPairTheModelAtLaunch() throws {
        let (model, _, _) = try makeModel(credentials: true)
        XCTAssertTrue(model.isPaired)
    }

    // MARK: Unpairing

    func testUnpairingClearsTheCredentialsAndTheTimeline() async throws {
        let (model, _, store) = try makeModel(credentials: true)
        await model.send("hello")
        XCTAssertEqual(model.timeline.pending.count, 1)

        model.unpair()

        XCTAssertFalse(model.isPaired)
        XCTAssertNil(try store.load())
        XCTAssertTrue(model.timeline.pending.isEmpty)
        XCTAssertEqual(model.timeline.lastEventId, 0)
        XCTAssertFalse(model.isConnected)
    }

    // MARK: Sending

    func testSendingAddsAPendingMessageAndPostsTheCommand() async throws {
        let (model, server, _) = try makeModel(credentials: true)
        await model.send("  帮我查一下  \n")

        XCTAssertEqual(model.timeline.pending.map(\.text), ["帮我查一下"])
        XCTAssertTrue(model.failedClientIds.isEmpty)
        let request = try XCTUnwrap(server.requests(to: "/api/commands").first)
        XCTAssertEqual(request.command, ["type": "message.send", "clientId": "c-test-1", "text": "帮我查一下"])
    }

    func testBlankTextIsNotSent() async throws {
        let (model, server, _) = try makeModel(credentials: true)
        await model.send("  \n ")
        XCTAssertTrue(model.timeline.pending.isEmpty)
        XCTAssertTrue(server.requests(to: "/api/commands").isEmpty)
    }

    func testAFailedSendLeavesAFailedPendingMessageAndRetryReusesItsClientId() async throws {
        let (model, server, _) = try makeModel(
            credentials: true,
            replies: ["/api/commands": [StubReply(failure: .networkConnectionLost), StubReply(status: 202)]]
        )
        await model.send("你好")

        let clientId = try XCTUnwrap(model.timeline.pending.first?.clientId)
        XCTAssertEqual(model.timeline.pending.count, 1)
        XCTAssertEqual(model.failedClientIds, [clientId])

        await model.retry(clientId: clientId)

        XCTAssertTrue(model.failedClientIds.isEmpty)
        XCTAssertEqual(model.timeline.pending.count, 1)
        let sent = server.requests(to: "/api/commands")
        XCTAssertEqual(sent.count, 2)
        XCTAssertEqual(sent.map { $0.command?["clientId"] }, [clientId, clientId])
        XCTAssertEqual(sent.map { $0.command?["text"] }, ["你好", "你好"])
    }

    func testARejectedCommandFailsTheMessageToo() async throws {
        let (model, _, _) = try makeModel(credentials: true, replies: ["/api/commands": [StubReply(status: 400)]])
        await model.send("你好")
        XCTAssertEqual(model.failedClientIds.count, 1)
    }

    func testRetryingAMessageThatDidNotFailDoesNothing() async throws {
        let (model, server, _) = try makeModel(credentials: true)
        await model.send("你好")
        let clientId = try XCTUnwrap(model.timeline.pending.first?.clientId)
        await model.retry(clientId: clientId)
        XCTAssertEqual(server.requests(to: "/api/commands").count, 1)
    }

    func testStoppingARunPostsRunStop() async throws {
        let (model, server, _) = try makeModel(credentials: true)
        await model.stop(runId: "k7m2qa")
        let request = try XCTUnwrap(server.requests(to: "/api/commands").first)
        XCTAssertEqual(request.command, ["type": "run.stop", "runId": "k7m2qa"])
    }

    func testAFailedStopIsReported() async throws {
        let (model, _, _) = try makeModel(credentials: true, replies: ["/api/commands": [StubReply(status: 500)]])
        await model.stop(runId: "k7m2qa")
        XCTAssertNotNil(model.actionFailure)
    }

    // MARK: The event stream

    func testTheStreamAppliesEventsAndTheEchoReplacesThePendingMessage() async throws {
        let stream = StubReply.stream([messageFrame(id: 1, direction: "in", text: "你好", clientId: "c-test-1")])
        let (model, _, _) = try makeModel(credentials: true, replies: ["/api/events": [stream]])
        model.foreground()
        await model.send("你好")

        await eventually { model.timeline.messages.count == 1 && model.timeline.pending.isEmpty }
        await eventually { model.isConnected }
        XCTAssertEqual(model.timeline.lastEventId, 1)
        XCTAssertTrue(model.failedClientIds.isEmpty)
    }

    func testTheStreamStartsFromTheLastEventIdAfterABackgroundTrip() async throws {
        let first = StubReply.stream([messageFrame(id: 5, text: "第一条")])
        let (model, server, _) = try makeModel(credentials: true, replies: ["/api/events": [first, .stream()]])

        model.foreground()
        await eventually { model.timeline.lastEventId == 5 && model.isConnected }

        model.background()
        XCTAssertFalse(model.isConnected)

        model.foreground()
        await eventually { server.requests(to: "/api/events").count == 2 }
        let opened = server.requests(to: "/api/events")
        XCTAssertEqual(opened.map { $0.request.value(forHTTPHeaderField: "Last-Event-ID") }, ["0", "5"])
        await eventually { model.isConnected }
        XCTAssertEqual(model.timeline.messages.map(\.text), ["第一条"])
    }

    func testTheStreamDoesNotStartInTheBackgroundOrWithoutCredentials() async throws {
        let (unpaired, server, _) = try makeModel()
        unpaired.foreground()
        let (paired, pairedServer, _) = try makeModel(credentials: true)
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertTrue(server.requests(to: "/api/events").isEmpty)
        XCTAssertTrue(pairedServer.requests(to: "/api/events").isEmpty)
        XCTAssertFalse(paired.isConnected)
    }

    func testPairingInTheForegroundStartsTheStream() async throws {
        let (model, server, _) = try makeModel()
        model.foreground()
        await model.pair(with: server.pairingJSON)
        await eventually { model.isConnected }
        XCTAssertEqual(server.requests(to: "/api/events").count, 1)
    }

    func testForegroundWhileStreamingDoesNotOpenASecondStream() async throws {
        let (model, server, _) = try makeModel(credentials: true)
        model.foreground()
        await eventually { model.isConnected }
        model.foreground()
        try await Task.sleep(for: .milliseconds(50))
        XCTAssertEqual(server.requests(to: "/api/events").count, 1)
    }

    func testARevokedDeviceStopsTheStreamAndRepairingDeletesTheCredentials() async throws {
        let (model, server, store) = try makeModel(credentials: true, replies: ["/api/events": [StubReply(status: 401)]])
        model.foreground()
        await eventually { model.streamFailure == .unauthorized }
        XCTAssertFalse(model.isConnected)

        // Coming back to the foreground does not retry a revoked device.
        model.background()
        model.foreground()
        try await Task.sleep(for: .milliseconds(50))
        XCTAssertEqual(server.requests(to: "/api/events").count, 1)

        model.unpair()
        XCTAssertNil(try store.load())
        XCTAssertNil(model.streamFailure)
        XCTAssertFalse(model.isPaired)
    }

    func testRefusedAccessOnTheStreamCanBeRetried() async throws {
        let (model, server, _) = try makeModel(credentials: true, replies: ["/api/events": [StubReply(status: 403), .stream()]])
        model.foreground()
        await eventually { model.streamFailure == .forbidden }

        model.retryStream()

        XCTAssertNil(model.streamFailure)
        await eventually { model.isConnected }
        XCTAssertEqual(server.requests(to: "/api/events").count, 2)
    }

    func testARefusedSendShowsTheAccessError() async throws {
        let (model, _, _) = try makeModel(credentials: true, replies: ["/api/commands": [StubReply(status: 401)]])
        await model.send("你好")
        XCTAssertEqual(model.streamFailure, .unauthorized)
        XCTAssertEqual(model.failedClientIds.count, 1)
    }

    // MARK: What the chat shows

    func testAStopButtonTargetsTheNewestRunningTask() async throws {
        let frames = [
            runFrame(id: 1, runId: "aaaaaa", status: "done"),
            runFrame(id: 2, runId: "bbbbbb", kind: "subagent", status: "running"),
            runFrame(id: 3, runId: "cccccc", status: "running"),
        ]
        let (model, _, _) = try makeModel(credentials: true, replies: ["/api/events": [.stream(frames)]])
        XCTAssertNil(model.runningTask)

        model.foreground()
        await eventually { model.timeline.lastEventId == 3 }
        XCTAssertEqual(model.runningTask?.id, "cccccc")
    }

    func testTheStopButtonGoesWhenTheRunEnds() async throws {
        let frames = [
            runFrame(id: 1, runId: "cccccc", status: "running"),
            runFrame(id: 2, runId: "cccccc", status: "stopped"),
        ]
        let (model, _, _) = try makeModel(credentials: true, replies: ["/api/events": [.stream(frames)]])
        model.foreground()
        await eventually { model.timeline.lastEventId == 2 }
        XCTAssertNil(model.runningTask)
    }

    func testTheLiveReplyShowsTheDraftAndTheLatestStepOfARunningTask() async throws {
        let frames = [
            runFrame(id: 1, runId: "cccccc", status: "running"),
            stepFrame(runId: "cccccc", tool: "WebFetch", detail: "https://example.com/pricing"),
            deltaFrame(runId: "cccccc", streamId: "cccccc.1", text: "我先查"),
            deltaFrame(runId: "cccccc", streamId: "cccccc.1", text: "一下。"),
        ]
        let (model, _, _) = try makeModel(credentials: true, replies: ["/api/events": [.stream(frames)]])
        model.foreground()
        await eventually { model.liveReplies.first?.text == "我先查一下。" }

        let reply = try XCTUnwrap(model.liveReplies.first)
        XCTAssertEqual(model.liveReplies.count, 1)
        XCTAssertEqual(reply.runId, "cccccc")
        XCTAssertEqual(reply.stepText, "WebFetch：https://example.com/pricing")
    }

    func testARunningTaskWithOnlyAStepShowsTheStep() async throws {
        let frames = [
            runFrame(id: 1, runId: "cccccc", status: "running"),
            stepFrame(runId: "cccccc", tool: "Read", detail: "notes.md"),
        ]
        let (model, _, _) = try makeModel(credentials: true, replies: ["/api/events": [.stream(frames)]])
        model.foreground()
        await eventually { model.liveReplies.count == 1 }
        XCTAssertNil(model.liveReplies.first?.text)
        XCTAssertEqual(model.liveReplies.first?.stepText, "Read：notes.md")
    }

    func testTheStoredReplyReplacesTheDraft() async throws {
        let frames = [
            runFrame(id: 1, runId: "cccccc", status: "running"),
            deltaFrame(runId: "cccccc", streamId: "cccccc.1", text: "好的"),
            messageFrame(id: 2, text: "好的。", runId: "cccccc"),
        ]
        let (model, _, _) = try makeModel(credentials: true, replies: ["/api/events": [.stream(frames)]])
        model.foreground()
        await eventually { model.timeline.lastEventId == 2 }
        XCTAssertTrue(model.liveReplies.isEmpty)
    }

    // MARK: Text and keychain

    func testMessageTextIsInlineMarkdownThatKeepsItsWhitespace() {
        let text = MessageText.attributed("**粗体** 和 `代码`\n\n  第二段")
        XCTAssertEqual(String(text.characters), "粗体 和 代码\n\n  第二段")
        XCTAssertTrue(text.runs.contains { $0.inlinePresentationIntent?.contains(.stronglyEmphasized) == true })
        // Block syntax stays as typed.
        XCTAssertEqual(String(MessageText.attributed("# 标题\n- 一").characters), "# 标题\n- 一")
        // Text that is not valid Markdown still shows.
        XCTAssertEqual(String(MessageText.attributed("**未闭合").characters), "**未闭合")
    }

    func testTheKeychainAccessGroupComesFromInfoPlistExceptInTheSimulator() {
        let group = "ABCDE12345.com.example.alfred"
        XCTAssertEqual(AppKeychain.accessGroup(infoValue: group, simulator: false), group)
        XCTAssertNil(AppKeychain.accessGroup(infoValue: group, simulator: true))
        XCTAssertNil(AppKeychain.accessGroup(infoValue: nil, simulator: false))
        XCTAssertNil(AppKeychain.accessGroup(infoValue: "", simulator: false))
        XCTAssertNil(AppKeychain.accessGroup(infoValue: "$(AppIdentifierPrefix)com.example.alfred", simulator: false))
    }

    func testTheBuiltAppCarriesTheKeychainAccessGroupKey() {
        let value = Bundle.main.object(forInfoDictionaryKey: "AlfredKeychainAccessGroup")
        XCTAssertTrue(value is String, "Info.plist has no AlfredKeychainAccessGroup string")
    }
}
