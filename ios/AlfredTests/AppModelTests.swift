import AlfredKit
import Synchronization
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

    func testRetryWhileTheStoppedStreamIsStillHeldStartsAFreshStreamFromTheLastEvent() async throws {
        // The streams are scripted, so the first one stays open after it reports the stop: its task is still held when
        // the owner taps retry, however the tasks are scheduled.
        let streams = ScriptedStreams()
        let server = StubServer { _ in StubReply(status: 204) }
        let model = AppModel(
            store: InMemoryCredentialStore(try server.credentials()),
            session: server.session,
            openStream: streams.open
        )
        addTeardownBlock { @MainActor in
            model.background()
            withExtendedLifetime(server) {}
        }

        model.foreground()
        await eventually { streams.opened.count == 1 }
        guard let first = streams.opened.first else { return }
        first.continuation.yield(.received(try storedMessage(id: 5, text: "第一条")))
        first.continuation.yield(.stopped(.forbidden))
        await eventually { model.streamFailure == .forbidden }

        model.retryStream()

        XCTAssertNil(model.streamFailure)
        await eventually { streams.opened.count == 2 }
        guard streams.opened.count == 2 else { return }
        let second = streams.opened[1]
        XCTAssertEqual(second.after, 5)
        // The held stream is stopped, not left to end on its own.
        await eventually { first.isTerminated }

        second.continuation.yield(.connected)
        await eventually { model.isConnected }
        second.continuation.yield(.received(try storedMessage(id: 6, text: "第二条")))
        await eventually { model.timeline.lastEventId == 6 }

        // The stopped stream ends late: that must not clear the fresh one.
        first.continuation.finish()
        try await Task.sleep(for: .milliseconds(50))
        XCTAssertTrue(model.isConnected)
        XCTAssertEqual(streams.opened.count, 2)
    }

    func testABacklogLeavesTheSameStateAsTheEventsOneByOne() async throws {
        let at = "2026-10-26T08:00:00.000Z"
        var echo = TestData.messageEvent(1, id: "m1", direction: "in", text: "你好", at: at)
        echo["data"] = (echo["data"] as? [String: Any] ?? [:]).merging(["clientId": "c-test-1"]) { $1 }
        let asked: [String: Any] = [
            "id": "q-1", "runId": "cccccc",
            "questions": [[
                "question": "报告用哪种格式？", "header": "问题", "multiSelect": false,
                "options": [["label": "短表格", "description": "选 短表格"], ["label": "长文章", "description": "选 长文章"]],
            ]],
        ]
        let events = try [
            echo,
            TestData.messageEvent(2, id: "m2", direction: "out", text: "先问一下", at: at),
            ["id": 3, "at": at, "type": "question.asked", "data": asked],
            TestData.runEvent(4, run: TestData.runObject("cccccc", status: "running", startedAt: at), at: at),
            TestData.taskEvent(5, task: TestData.taskObject("t1")),
            TestData.messageEvent(6, id: "m3", direction: "out", text: "好了", at: at),
            TestData.runEvent(7, run: TestData.runObject("cccccc", status: "done", startedAt: at, endedAt: at), at: at),
        ].map(TestData.streamEvent)

        /// Delivers the events to a model that sent "你好" and is waiting for the echo, then reads what it holds.
        func outcome(asBacklog: Bool) async throws -> Outcome {
            let streams = ScriptedStreams()
            let server = StubServer { $0.url?.path == "/api/commands" ? StubReply(status: 202) : StubReply(status: 204) }
            let model = AppModel(
                store: InMemoryCredentialStore(try server.credentials()),
                session: server.session,
                makeClientId: { "c-test-1" },
                openStream: streams.open
            )
            addTeardownBlock { @MainActor in
                model.background()
                withExtendedLifetime(server) {}
            }
            model.foreground()
            await eventually { streams.opened.count == 1 }
            let stream = try XCTUnwrap(streams.opened.first)
            stream.continuation.yield(.connected)
            await eventually { model.isConnected }
            await model.send("你好")
            XCTAssertEqual(model.timeline.pending.map(\.clientId), ["c-test-1"])

            if asBacklog {
                stream.continuation.yield(.backlog(events))
                await eventually { model.timeline.lastEventId > 0 }
                XCTAssertEqual(model.timeline.lastEventId, 7, "the whole backlog is there the first time the model changes")
            } else {
                for event in events { stream.continuation.yield(.received(event)) }
                await eventually { model.timeline.lastEventId == 7 }
            }
            model.openChat(for: NotificationTarget(eventId: 3, runId: nil))
            return Outcome(
                timeline: model.timeline,
                tasks: model.taskCatalog,
                failed: model.failedClientIds,
                questionRow: model.revealRequest?.itemId
            )
        }

        let oneByOne = try await outcome(asBacklog: false)
        let backlog = try await outcome(asBacklog: true)

        XCTAssertEqual(backlog, oneByOne)
        XCTAssertEqual(backlog.timeline.messages.map(\.text), ["你好", "先问一下", "好了"])
        XCTAssertTrue(backlog.timeline.pending.isEmpty, "the echo replaced the pending message")
        XCTAssertEqual(backlog.timeline.questions.map(\.state), [.ended], "the run ended with the question open")
        XCTAssertEqual(backlog.tasks.task(id: "t1")?.title, "每日简报")
        XCTAssertEqual(backlog.questionRow, "q-q-1", "the question's event is tracked for a notification tap")
    }

    func testAnEmptyBacklogChangesNothing() async throws {
        let streams = ScriptedStreams()
        let server = StubServer { _ in StubReply(status: 204) }
        let model = AppModel(store: InMemoryCredentialStore(try server.credentials()), session: server.session, openStream: streams.open)
        addTeardownBlock { @MainActor in
            model.background()
            withExtendedLifetime(server) {}
        }
        model.foreground()
        await eventually { streams.opened.count == 1 }
        let stream = try XCTUnwrap(streams.opened.first)
        stream.continuation.yield(.connected)
        stream.continuation.yield(.backlog([]))
        stream.continuation.yield(.received(try storedMessage(id: 1, text: "第一条")))
        await eventually { model.timeline.lastEventId == 1 }
        XCTAssertTrue(model.isConnected)
        XCTAssertEqual(model.timeline.messages.map(\.text), ["第一条"])
    }

    func testARefusedSendShowsTheAccessError() async throws {
        let (model, _, _) = try makeModel(credentials: true, replies: ["/api/commands": [StubReply(status: 401)]])
        await model.send("你好")
        XCTAssertEqual(model.streamFailure, .unauthorized)
        XCTAssertEqual(model.failedClientIds.count, 1)
    }

    // MARK: What the chat shows

    func testAStopButtonTargetsTheNewestRunningChatRun() async throws {
        let frames = [
            runFrame(id: 1, runId: "aaaaaa", status: "done"),
            runFrame(id: 2, runId: "bbbbbb", kind: "subagent", status: "running"),
            runFrame(id: 3, runId: "cccccc", status: "running"),
        ]
        let (model, _, _) = try makeModel(credentials: true, replies: ["/api/events": [.stream(frames)]])
        XCTAssertNil(model.runningChatRun)

        model.foreground()
        await eventually { model.timeline.lastEventId == 3 }
        XCTAssertEqual(model.runningChatRun?.id, "cccccc")
    }

    func testAStopButtonTargetsTheChatRunAndNotANewerTaskRun() async throws {
        let frames = [
            runFrame(id: 1, runId: "cccccc", status: "running", startedAt: "2026-10-25T08:00:00.000Z"),
            runFrame(id: 2, runId: "dddddd", status: "running", taskId: "aaaaaa", startedAt: "2026-10-25T09:00:00.000Z"),
        ]
        let (model, _, _) = try makeModel(credentials: true, replies: ["/api/events": [.stream(frames)]])
        model.foreground()
        await eventually { model.timeline.lastEventId == 2 }

        XCTAssertEqual(model.runningChatRun?.id, "cccccc")
        XCTAssertEqual(model.taskRunBanners.map(\.runId), ["dddddd"])
    }

    func testAStopButtonGoesWhenOnlyATaskRunIsRunning() async throws {
        let frames = [runFrame(id: 1, runId: "dddddd", status: "running", taskId: "aaaaaa")]
        let (model, _, _) = try makeModel(credentials: true, replies: ["/api/events": [.stream(frames)]])
        model.foreground()
        await eventually { model.timeline.lastEventId == 1 }

        XCTAssertNil(model.runningChatRun)
    }

    func testTheStopButtonGoesWhenTheRunEnds() async throws {
        let frames = [
            runFrame(id: 1, runId: "cccccc", status: "running"),
            runFrame(id: 2, runId: "cccccc", status: "stopped"),
        ]
        let (model, _, _) = try makeModel(credentials: true, replies: ["/api/events": [.stream(frames)]])
        model.foreground()
        await eventually { model.timeline.lastEventId == 2 }
        XCTAssertNil(model.runningChatRun)
    }

    func testTheBannerNamesARunningTaskRunByItsTasksTitleAndShowsItsLatestStep() async throws {
        let frames = [
            taskFrame(id: 1, task: TestData.taskObject("aaaaaa", title: "每日简报")),
            runFrame(id: 2, runId: "dddddd", status: "running", taskId: "aaaaaa"),
            stepFrame(runId: "dddddd", tool: "Read", detail: "notes.md"),
        ]
        let (model, _, _) = try makeModel(credentials: true, replies: ["/api/events": [.stream(frames)]])
        model.foreground()
        await eventually { model.timeline.latestStep["dddddd"] != nil }

        XCTAssertEqual(model.taskRunBanners, [AppModel.TaskRunBanner(runId: "dddddd", title: "每日简报", stepText: "Read：notes.md")])
    }

    func testTheBannerNamesTheRunWhenTheAppDoesNotKnowItsTask() async throws {
        let frames = [runFrame(id: 1, runId: "dddddd", status: "running", taskId: "zzzzzz", title: "调研简报")]
        let (model, _, _) = try makeModel(credentials: true, replies: ["/api/events": [.stream(frames)]])
        model.foreground()
        await eventually { model.timeline.lastEventId == 1 }

        XCTAssertEqual(model.taskRunBanners.map(\.title), ["调研简报"])
        XCTAssertNil(model.taskRunBanners.first?.stepText)
    }

    func testSeveralRunningTaskRunsGetOneBannerEachOldestFirst() async throws {
        let frames = [
            taskFrame(id: 1, task: TestData.taskObject("aaaaaa", title: "每日简报")),
            taskFrame(id: 2, task: TestData.taskObject("bbbbbb", title: "价格监控")),
            runFrame(id: 3, runId: "ffffff", status: "running", taskId: "aaaaaa", startedAt: "2026-10-25T10:00:00.000Z"),
            runFrame(id: 4, runId: "eeeeee", status: "running", taskId: "bbbbbb", startedAt: "2026-10-25T09:00:00.000Z"),
            stepFrame(runId: "ffffff", tool: "WebFetch", detail: "https://example.com"),
        ]
        let (model, _, _) = try makeModel(credentials: true, replies: ["/api/events": [.stream(frames)]])
        model.foreground()
        await eventually { model.timeline.latestStep["ffffff"] != nil }

        XCTAssertEqual(model.taskRunBanners.map(\.runId), ["eeeeee", "ffffff"])
        XCTAssertEqual(model.taskRunBanners.map(\.title), ["价格监控", "每日简报"])
        XCTAssertEqual(model.taskRunBanners.map(\.stepText), [nil, "WebFetch：https://example.com"])
    }

    func testTheBannerGoesWhenTheTaskRunEnds() async throws {
        let frames = [
            runFrame(id: 1, runId: "dddddd", status: "running", taskId: "aaaaaa"),
            runFrame(id: 2, runId: "dddddd", status: "done", taskId: "aaaaaa"),
        ]
        let (model, _, _) = try makeModel(credentials: true, replies: ["/api/events": [.stream(frames)]])
        model.foreground()
        await eventually { model.timeline.lastEventId == 2 }

        XCTAssertTrue(model.taskRunBanners.isEmpty)
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

    func testTheLiveReplyLeavesOutTheDraftAndStepOfATaskRun() async throws {
        let frames = [
            runFrame(id: 1, runId: "cccccc", status: "running"),
            runFrame(id: 2, runId: "dddddd", status: "running", taskId: "aaaaaa"),
            deltaFrame(runId: "cccccc", streamId: "cccccc.1", text: "我先查"),
            deltaFrame(runId: "dddddd", streamId: "dddddd.1", text: "定时任务的草稿"),
            stepFrame(runId: "dddddd", tool: "WebFetch", detail: "https://example.com/pricing"),
        ]
        let (model, _, _) = try makeModel(credentials: true, replies: ["/api/events": [.stream(frames)]])
        model.foreground()
        await eventually { model.timeline.latestStep["dddddd"] != nil }

        XCTAssertEqual(model.liveReplies.map(\.runId), ["cccccc"])
        XCTAssertEqual(model.liveReplies.first?.text, "我先查")
        XCTAssertNil(model.liveReplies.first?.stepText)
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

/// What a model holds once the events of a test are in.
@MainActor
private struct Outcome: Equatable {
    let timeline: Timeline
    let tasks: TaskCatalog
    let failed: Set<String>
    let questionRow: String?
}

/// Streams that a test opens by hand. Each one stays open until the test finishes it, so the task reading it is held
/// until then.
private final class ScriptedStreams: Sendable {
    struct Opened: Sendable {
        let after: Int64
        let continuation: AsyncStream<EventStreamUpdate>.Continuation

        /// Whether the consumer has let go of the stream, as a cancelled stream task does. It is asked with a yield,
        /// which a stream the consumer has let go refuses.
        var isTerminated: Bool {
            if case .terminated = continuation.yield(.connected) { return true }
            return false
        }
    }

    private let items = Mutex<[Opened]>([])

    var opened: [Opened] {
        items.withLock { $0 }
    }

    func open(_: AlfredClient, after lastEventId: Int64) -> AsyncStream<EventStreamUpdate> {
        AsyncStream { continuation in
            items.withLock { $0.append(Opened(after: lastEventId, continuation: continuation)) }
        }
    }
}

/// A stored message as the event stream decodes it: the frame `messageFrame` builds, without the SSE lines.
private func storedMessage(id: Int, text: String) throws -> StreamEvent {
    let frame = String(decoding: messageFrame(id: id, text: text), as: UTF8.self)
    let json = frame.drop(while: { $0 != "{" }).dropLast(2)
    return try JSONDecoder().decode(StreamEvent.self, from: Data(json.utf8))
}
