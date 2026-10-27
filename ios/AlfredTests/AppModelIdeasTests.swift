import AlfredKit
import XCTest

@testable import Alfred

/// The app's ideas: kept current by `idea.updated` events, loaded from `GET /api/ideas`, counted for the badge until
/// they are seen, changed by commands, and taken to the chat's composer or to a task.
@MainActor
final class AppModelIdeasTests: XCTestCase {
    /// A paired model on a fake server whose event stream is scripted: `updates` arrive in order, and the stream stays
    /// open. `list` answers `GET /api/ideas` in turn, `commands` answers `POST /api/commands`.
    private func makeModel(
        updates: [EventStreamUpdate] = [],
        list: [StubReply] = [],
        commands: [StubReply] = [StubReply(status: 202)],
        seen: SeenIdeas = SeenIdeas()
    ) throws -> (AppModel, StubServer) {
        let listScript = ReplyScript(list.isEmpty ? [try ideas([])] : list)
        let commandScript = ReplyScript(commands)
        let server = StubServer { request in
            switch request.url?.path ?? "" {
            case "/api/ideas": return listScript.next()
            case "/api/tasks": return StubReply(chunks: [(try? TestData.taskList([])) ?? Data()])
            case "/api/commands": return commandScript.next()
            default: return StubReply(status: 404)
            }
        }
        let model = AppModel(
            store: InMemoryCredentialStore(try server.credentials()),
            session: server.session,
            seenIdeas: seen,
            openStream: { _, _ in AsyncStream { continuation in updates.forEach { continuation.yield($0) } } }
        )
        addTeardownBlock { @MainActor in
            model.background()
            withExtendedLifetime(server) {}
        }
        return (model, server)
    }

    private func ideas(_ objects: [[String: Any]], generatingRunId: String? = nil, lastGeneration: [String: Any]? = nil) throws -> StubReply {
        StubReply(chunks: [try TestData.ideaList(objects, generatingRunId: generatingRunId, lastGeneration: lastGeneration)])
    }

    private func event(_ id: Int, _ idea: [String: Any]) throws -> EventStreamUpdate {
        .received(try TestData.streamEvent(TestData.ideaEvent(id, idea: idea)))
    }

    private func three() -> [[String: Any]] {
        [
            TestData.ideaObject("aaaaaa", createdAt: "2026-10-27T01:00:00.000Z"),
            TestData.ideaObject("bbbbbb", createdAt: "2026-10-27T02:00:00.000Z"),
            TestData.ideaObject("cccccc", createdAt: "2026-10-27T03:00:00.000Z"),
        ]
    }

    private func command(_ server: StubServer) throws -> [String: Any] {
        try XCTUnwrap(server.requests(to: "/api/commands").last?.chatCommand)
    }

    private func error(_ message: String, status: Int) -> StubReply {
        StubReply(status: status, chunks: [Data(#"{"error":"\#(message)"}"#.utf8)])
    }

    // MARK: Loading and events

    func testTheListIsLoadedWhenTheStreamConnects() async throws {
        let (model, server) = try makeModel(updates: [.connected], list: [try ideas(three())])
        model.foreground()

        await eventually { model.ideaCatalog.hasLoaded }
        XCTAssertEqual(model.ideaCatalog.open.map(\.id), ["cccccc", "bbbbbb", "aaaaaa"])
        XCTAssertEqual(server.requests(to: "/api/ideas").count, 1)
    }

    func testTheListIsLoadedAgainWhenTheStreamResumes() async throws {
        let (model, server) = try makeModel(
            updates: [.connected, .disconnected, .connected],
            list: [try ideas([TestData.ideaObject("aaaaaa")]), try ideas(three())]
        )
        model.foreground()

        await eventually { server.requests(to: "/api/ideas").count == 2 }
        await eventually { model.ideaCatalog.open.count == 3 }
    }

    func testIdeaUpdatedEventsAddAndChangeIdeas() async throws {
        let (model, _) = try makeModel(updates: [
            try event(1, TestData.ideaObject("aaaaaa", title: "旧标题")),
            try event(2, TestData.ideaObject("bbbbbb", title: "另一个", createdAt: "2026-10-27T02:00:00.000Z")),
            try event(3, TestData.ideaObject("aaaaaa", state: "archived", updatedAt: "2026-10-27T05:00:00.000Z")),
        ])
        model.foreground()

        await eventually { model.ideaCatalog.history.count == 1 }
        XCTAssertEqual(model.ideaCatalog.open.map(\.title), ["另一个"])
        XCTAssertEqual(model.timeline.lastEventId, 3, "the timeline still moves its resume point past idea events")
    }

    func testAFailedReadIsKeptUntilAReadWorks() async throws {
        let (model, _) = try makeModel(list: [error("坏了", status: 500), try ideas(three())])
        await model.refreshIdeas()
        XCTAssertNotNil(model.ideaFailure)
        XCTAssertFalse(model.ideaCatalog.hasLoaded)

        await model.refreshIdeas()
        XCTAssertNil(model.ideaFailure)
        XCTAssertTrue(model.ideaCatalog.hasLoaded)
    }

    // MARK: The line about the last generation

    func testTheListsLastGenerationIsKeptAndSaysItsNote() async throws {
        let (model, _) = try makeModel(list: [try ideas([], lastGeneration: TestData.generationObject(note: "最近的对话多是在测试功能，暂时没有值得提的。"))])
        XCTAssertNil(model.ideaCatalog.generationLine)
        await model.refreshIdeas()
        XCTAssertEqual(model.ideaCatalog.generationLine, "最近的对话多是在测试功能，暂时没有值得提的。")
    }

    func testAFinishedGenerationRunReadsTheListAgainSoTheLineAppearsWithoutAReconnect() async throws {
        let (model, server) = try makeModel(
            updates: [
                .connected,
                .received(try TestData.generationEvent(1, run: "c9t5hq", status: "queued")),
                .received(try TestData.generationEvent(2, run: "c9t5hq", status: "running")),
                .received(try TestData.generationEvent(3, run: "c9t5hq", status: "done")),
            ],
            list: [
                try ideas([TestData.ideaObject("aaaaaa")], generatingRunId: "c9t5hq"),
                try ideas([TestData.ideaObject("aaaaaa")], lastGeneration: TestData.generationObject("c9t5hq", note: "这次没找到新的。")),
            ]
        )
        model.foreground()

        await eventually { model.ideaCatalog.generationLine == "这次没找到新的。" }
        XCTAssertEqual(server.requests(to: "/api/ideas").count, 2, "once when the stream connected, once when the run ended")
        XCTAssertFalse(model.ideaCatalog.isGenerating)
    }

    func testARunThatHasNotEndedAndRunsOfOtherKindsDoNotReadTheListAgain() async throws {
        let (model, server) = try makeModel(updates: [
            .connected,
            .received(try TestData.generationEvent(1, run: "c9t5hq", status: "queued")),
            .received(try TestData.generationEvent(2, run: "c9t5hq", status: "running")),
            .received(try TestData.streamEvent(TestData.runEvent(3, run: TestData.runObject("r1", status: "done"), at: "2026-10-27T01:00:00.000Z"))),
            try event(4, TestData.ideaObject("aaaaaa")),
        ])
        model.foreground()

        await eventually { model.timeline.lastEventId == 4 }
        try await Task.sleep(for: .milliseconds(200))
        XCTAssertEqual(server.requests(to: "/api/ideas").count, 1, "only the read when the stream connected")
    }

    func testAGenerationThatAddedIdeasLeavesNoLine() async throws {
        let (model, _) = try makeModel(
            updates: [
                .connected,
                .received(try TestData.generationEvent(1, run: "c9t5hq", status: "running")),
                .received(try TestData.generationEvent(2, run: "c9t5hq", status: "done")),
            ],
            list: [
                try ideas([], lastGeneration: TestData.generationObject("aaaaa2", note: "上一次没有。", endedAt: "2026-10-28T01:00:00.000Z")),
                try ideas(
                    [TestData.ideaObject("aaaaaa")],
                    lastGeneration: TestData.generationObject("c9t5hq", added: 1, note: "想到一个。", endedAt: "2026-10-28T02:00:00.000Z")
                ),
            ]
        )
        model.foreground()

        await eventually { model.ideaCatalog.lastGeneration?.runId == "c9t5hq" }
        XCTAssertNil(model.ideaCatalog.generationLine)
        XCTAssertEqual(model.ideaCatalog.open.map(\.id), ["aaaaaa"])
    }

    func testAnEndedGenerationIsReadOnceAgainForEachBurstOfEndsNotOncePerEnd() async throws {
        let ends = try (1...6).map { EventStreamUpdate.received(try TestData.generationEvent($0, run: "c9t5h\($0)", status: "done")) }
        let (model, server) = try makeModel(
            updates: [.connected] + ends,
            list: [try ideas([]), try ideas([], lastGeneration: TestData.generationObject("c9t5h6", note: "最后一次没有。"))]
        )
        model.foreground()

        await eventually { model.ideaCatalog.generationLine == "最后一次没有。" }
        XCTAssertLessThanOrEqual(server.requests(to: "/api/ideas").count, 3, "the read at the connection and at most two for the ends")
    }

    // MARK: A generation under way

    func testTheListSaysAGenerationIsUnderWay() async throws {
        let (model, _) = try makeModel(list: [try ideas([], generatingRunId: "c9t5hq")])
        await model.refreshIdeas()
        XCTAssertTrue(model.ideaCatalog.isGenerating)
    }

    func testAGenerationRunsEventsStartAndEndIt() async throws {
        let (model, _) = try makeModel(updates: [
            .received(try TestData.generationEvent(1, run: "c9t5hq", status: "queued")),
            .received(try TestData.generationEvent(2, run: "c9t5hq", status: "running")),
        ])
        model.foreground()
        await eventually { model.ideaCatalog.isGenerating }
        model.background()

        let (ended, _) = try makeModel(updates: [
            .received(try TestData.generationEvent(1, run: "c9t5hq", status: "running")),
            .received(try TestData.generationEvent(2, run: "c9t5hq", status: "done")),
        ])
        ended.foreground()
        await eventually { ended.timeline.lastEventId == 2 }
        XCTAssertFalse(ended.ideaCatalog.isGenerating)
    }

    // MARK: Seen and the badge

    func testOpenIdeasCountForTheBadgeUntilTheTabIsSeen() async throws {
        let (model, _) = try makeModel(updates: [.connected], list: [try ideas(three())])
        model.foreground()
        await eventually { model.ideaCatalog.hasLoaded }

        XCTAssertEqual(model.unseenIdeaCount, 3)
        model.selectedTab = .tasks
        XCTAssertEqual(model.unseenIdeaCount, 3, "another tab sees nothing")

        model.selectedTab = .ideas
        XCTAssertEqual(model.unseenIdeaCount, 0)
        model.selectedTab = .chat
        XCTAssertEqual(model.unseenIdeaCount, 0, "a seen idea stays seen")
    }

    func testAnIdeaThatArrivesWhileTheTabIsOnScreenIsSeenAtOnce() async throws {
        let (model, _) = try makeModel(updates: [
            try event(1, TestData.ideaObject("aaaaaa")),
            try event(2, TestData.ideaObject("bbbbbb")),
        ])
        model.selectedTab = .ideas
        model.foreground()

        await eventually { model.ideaCatalog.open.count == 2 }
        XCTAssertEqual(model.unseenIdeaCount, 0)
    }

    func testAnIdeaThatArrivesElsewhereCountsUntilTheTabIsOpened() async throws {
        let (model, _) = try makeModel(updates: [try event(1, TestData.ideaObject("aaaaaa"))])
        model.foreground()

        await eventually { model.ideaCatalog.open.count == 1 }
        XCTAssertEqual(model.unseenIdeaCount, 1)
    }

    func testTheTabIsNotSeenWhileTheAppIsNotInTheForeground() async throws {
        let (model, _) = try makeModel(list: [try ideas(three())])
        model.selectedTab = .ideas
        await model.refreshIdeas()
        XCTAssertEqual(model.unseenIdeaCount, 3, "the app has not been active")

        model.foreground()
        XCTAssertEqual(model.unseenIdeaCount, 0, "the tab is on screen as the app becomes active")
    }

    func testOnlyOpenIdeasCount() async throws {
        let (model, _) = try makeModel(list: [try ideas([
            TestData.ideaObject("aaaaaa"),
            TestData.ideaObject("bbbbbb", state: "archived"),
            TestData.ideaObject("cccccc", state: "rejected", rejection: ["reason": "not-now"]),
            TestData.ideaObject("dddddd", state: "accepted", taskId: "tttttt"),
        ])])
        await model.refreshIdeas()
        XCTAssertEqual(model.unseenIdeaCount, 1)
    }

    func testAnIdeaThatIsClosedNoLongerCounts() async throws {
        let (model, _) = try makeModel(
            updates: [try event(1, TestData.ideaObject("aaaaaa", state: "archived", updatedAt: "2026-10-27T05:00:00.000Z"))],
            list: [try ideas(three())]
        )
        await model.refreshIdeas()
        XCTAssertEqual(model.unseenIdeaCount, 3)
        model.foreground()
        await eventually { model.ideaCatalog.open.count == 2 }
        XCTAssertEqual(model.unseenIdeaCount, 2)
    }

    func testSeenIdeasAreKeptOnThePhoneAndPrunedToTheOnesTheCatalogHolds() async throws {
        let suite = "alfred.test." + UUID().uuidString
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        addTeardownBlock { defaults.removePersistentDomain(forName: suite) }

        let first = SeenIdeas(defaults: defaults)
        first.markSeen(["aaaaaa", "bbbbbb", "gone00"])

        // A later launch reads them back; they stay until a list says which ideas still exist.
        let (model, _) = try makeModel(list: [try ideas([TestData.ideaObject("aaaaaa"), TestData.ideaObject("cccccc")])], seen: SeenIdeas(defaults: defaults))
        XCTAssertEqual(model.seenIdeas.ids, ["aaaaaa", "bbbbbb", "gone00"])
        await model.refreshIdeas()
        XCTAssertEqual(model.seenIdeas.ids, ["aaaaaa"], "ideas the list does not hold are forgotten")
        XCTAssertEqual(SeenIdeas(defaults: defaults).ids, ["aaaaaa"], "and the phone keeps the pruned set")
        XCTAssertEqual(model.unseenIdeaCount, 1, "cccccc is new")
    }

    func testAFailedReadPrunesNothing() async throws {
        let seen = SeenIdeas()
        seen.markSeen(["aaaaaa"])
        let (model, _) = try makeModel(list: [error("坏了", status: 500)], seen: seen)
        await model.refreshIdeas()
        XCTAssertEqual(model.seenIdeas.ids, ["aaaaaa"])
    }

    func testUnpairingForgetsTheIdeasAndWhatWasSeen() async throws {
        let (model, _) = try makeModel(list: [try ideas(three())])
        model.selectedTab = .ideas
        model.foreground()
        await model.refreshIdeas()
        XCTAssertEqual(model.seenIdeas.ids.count, 3)

        model.unpair()
        XCTAssertEqual(model.seenIdeas.ids, [])
        XCTAssertFalse(model.ideaCatalog.hasLoaded)
        XCTAssertEqual(model.ideaCatalog.open, [])
    }

    // MARK: Accepting

    private func accepted(idea: [String: Any], task: [String: Any]) throws -> StubReply {
        StubReply(chunks: [try JSONSerialization.data(withJSONObject: ["idea": idea, "task": task])])
    }

    func testAcceptingAOneOffIdeaSendsTheFormsTaskWithNoSchedule() async throws {
        let open = TestData.ideaObject("aaaaaa", title: "对比带宽", brief: "查三家的带宽。", model: "sonnet", estimateUsd: 0.35)
        let done = TestData.ideaObject("aaaaaa", title: "对比带宽", state: "accepted", taskId: "tttttt", updatedAt: "2026-10-27T02:00:00.000Z")
        let (model, server) = try makeModel(
            list: [try ideas([open])],
            commands: [try accepted(idea: done, task: TestData.taskObject("tttttt", title: "对比带宽", origin: "idea"))]
        )
        await model.refreshIdeas()
        let idea = try XCTUnwrap(model.ideaCatalog.idea(id: "aaaaaa"))
        var form = TaskForm(accepting: idea)
        form.brief = "写两行笔记。"
        form.model = .haiku
        form.budgetText = "0.3"

        let task = try await model.acceptIdea(idea, as: form.acceptance())

        let sent = try command(server)
        XCTAssertEqual(sent["type"] as? String, "idea.accept")
        XCTAssertEqual(sent["ideaId"] as? String, "aaaaaa")
        XCTAssertEqual(sent["title"] as? String, "对比带宽")
        XCTAssertEqual(sent["brief"] as? String, "写两行笔记。")
        XCTAssertEqual(sent["model"] as? String, "haiku")
        XCTAssertEqual(sent["budgetUsd"] as? Double, 0.3)
        XCTAssertNil(sent["schedule"], "立即 sends no schedule")
        XCTAssertEqual(task.id, "tttttt")
        XCTAssertEqual(model.ideaCatalog.history.map(\.id), ["aaaaaa"], "the idea is accepted at once")
        XCTAssertEqual(model.ideaCatalog.open, [])
        XCTAssertEqual(model.taskCatalog.task(id: "tttttt")?.title, "对比带宽", "and its task is listed at once")
    }

    func testAcceptingARecurringIdeaSendsItsSchedule() async throws {
        let proposed: [String: Any] = ["kind": "weekly", "days": [1], "time": "09:00"]
        let open = TestData.ideaObject("aaaaaa", kind: "recurring", schedule: proposed)
        let done = TestData.ideaObject("aaaaaa", kind: "recurring", schedule: proposed, state: "accepted", taskId: "tttttt")
        let (model, server) = try makeModel(
            list: [try ideas([open])],
            commands: [try accepted(idea: done, task: TestData.taskObject("tttttt", schedule: proposed, origin: "idea"))]
        )
        await model.refreshIdeas()
        let idea = try XCTUnwrap(model.ideaCatalog.idea(id: "aaaaaa"))

        _ = try await model.acceptIdea(idea, as: TaskForm(accepting: idea).acceptance())

        let sent = try command(server)
        let schedule = try XCTUnwrap(sent["schedule"] as? [String: Any])
        XCTAssertEqual(schedule["kind"] as? String, "weekly")
        XCTAssertEqual(schedule["days"] as? [Int], [1])
        XCTAssertEqual(schedule["time"] as? String, "09:00")
        XCTAssertEqual(sent["budgetUsd"] as? Double, 2)
    }

    func testARefusedAcceptanceIsThrownWithTheServersWordsAndTheIdeaStaysOpen() async throws {
        let (model, _) = try makeModel(
            list: [try ideas([TestData.ideaObject("aaaaaa")])],
            commands: [error("执行时间已过", status: 400)]
        )
        await model.refreshIdeas()
        let idea = try XCTUnwrap(model.ideaCatalog.idea(id: "aaaaaa"))

        do {
            _ = try await model.acceptIdea(idea, as: TaskForm(accepting: idea).acceptance())
            XCTFail("the server refused")
        } catch {
            XCTAssertEqual(LoadFailure.commandMessage(for: error), "执行时间已过")
        }
        XCTAssertEqual(model.ideaCatalog.open.map(\.id), ["aaaaaa"])
    }

    // MARK: Rejecting

    func testRejectingWithAReasonAndNoNoteSendsOnlyTheReason() async throws {
        let rejected = TestData.ideaObject(
            "aaaaaa", state: "rejected", rejection: ["reason": "not-now"], updatedAt: "2026-10-27T02:00:00.000Z"
        )
        let (model, server) = try makeModel(
            list: [try ideas([TestData.ideaObject("aaaaaa")])],
            commands: [StubReply(chunks: [try JSONSerialization.data(withJSONObject: ["idea": rejected])])]
        )
        await model.refreshIdeas()

        try await model.rejectIdea(id: "aaaaaa", reason: .notNow, note: nil)

        let sent = try command(server)
        XCTAssertEqual(sent["type"] as? String, "idea.reject")
        XCTAssertEqual(sent["ideaId"] as? String, "aaaaaa")
        XCTAssertEqual(sent["reason"] as? String, "not-now")
        XCTAssertNil(sent["note"])
        XCTAssertEqual(model.ideaCatalog.history.first?.rejection?.reason, .notNow, "the idea moves to history at once")
        XCTAssertEqual(model.ideaCatalog.open, [])
    }

    func testRejectingWithANoteSendsTheTrimmedNote() async throws {
        let rejected = TestData.ideaObject(
            "aaaaaa", state: "rejected", rejection: ["reason": "too-expensive", "note": "太贵了"], updatedAt: "2026-10-27T02:00:00.000Z"
        )
        let (model, server) = try makeModel(
            list: [try ideas([TestData.ideaObject("aaaaaa")])],
            commands: [StubReply(chunks: [try JSONSerialization.data(withJSONObject: ["idea": rejected])])]
        )
        await model.refreshIdeas()

        try await model.rejectIdea(id: "aaaaaa", reason: .tooExpensive, note: "  太贵了\n")

        let sent = try command(server)
        XCTAssertEqual(sent["reason"] as? String, "too-expensive")
        XCTAssertEqual(sent["note"] as? String, "太贵了")
    }

    func testABlankNoteIsNotSent() async throws {
        let rejected = TestData.ideaObject("aaaaaa", state: "rejected", rejection: ["reason": "wrong-direction"], updatedAt: "2026-10-27T02:00:00.000Z")
        let (model, server) = try makeModel(
            list: [try ideas([TestData.ideaObject("aaaaaa")])],
            commands: [StubReply(chunks: [try JSONSerialization.data(withJSONObject: ["idea": rejected])])]
        )
        await model.refreshIdeas()

        try await model.rejectIdea(id: "aaaaaa", reason: .wrongDirection, note: "   ")

        XCTAssertNil(try command(server)["note"])
    }

    func testARefusedRejectionIsThrownAndTheIdeaStaysOpen() async throws {
        let (model, _) = try makeModel(
            list: [try ideas([TestData.ideaObject("aaaaaa")])],
            commands: [error("idea is archived", status: 409)]
        )
        await model.refreshIdeas()

        do {
            try await model.rejectIdea(id: "aaaaaa", reason: .notNow, note: nil)
            XCTFail("the server refused")
        } catch {
            XCTAssertEqual(LoadFailure.commandMessage(for: error), "idea is archived")
        }
        XCTAssertEqual(model.ideaCatalog.open.map(\.id), ["aaaaaa"])
    }

    // MARK: Generating

    func testGeneratingSendsTheCommandAndShowsAGenerationAtOnce() async throws {
        let (model, server) = try makeModel(commands: [StubReply(status: 202, chunks: [Data(#"{"runId":"c9t5hq"}"#.utf8)])])

        try await model.generateIdeas()

        XCTAssertEqual(try command(server)["type"] as? String, "idea.generate")
        XCTAssertTrue(model.ideaCatalog.isGenerating)
    }

    func testARefusedGenerationIsThrownWithTheServersWords() async throws {
        for (status, message) in [(409, "a generation is already running"), (503, "idea generation is not available")] {
            let (model, _) = try makeModel(commands: [error(message, status: status)])
            do {
                try await model.generateIdeas()
                XCTFail("the server refused with \(status)")
            } catch {
                XCTAssertEqual(LoadFailure.commandMessage(for: error), message)
            }
            XCTAssertFalse(model.ideaCatalog.isGenerating)
        }
    }

    func testARefusalWithNoWordsShowsTheStatus() async throws {
        let (model, _) = try makeModel(commands: [StubReply(status: 503)])
        do {
            try await model.generateIdeas()
            XCTFail("the server refused")
        } catch {
            XCTAssertEqual(LoadFailure.commandMessage(for: error), "服务器返回 503")
        }
    }

    // MARK: 讨论

    func testDiscussingPutsTheIdeaIntoAnEmptyComposerAndShowsTheChat() async throws {
        let (model, server) = try makeModel()
        let idea = try TestData.idea("aaaaaa", title: "追踪价格", brief: "每周看一次定价页。")
        model.selectedTab = .ideas

        model.discuss(idea)

        XCTAssertEqual(model.composerText, "关于想法「追踪价格」：\n每周看一次定价页。")
        XCTAssertEqual(model.selectedTab, .chat)
        XCTAssertEqual(server.requests(to: "/api/commands").count, 0, "it sends nothing")
        XCTAssertTrue(model.timeline.pending.isEmpty)
    }

    func testDiscussingKeepsWhatTheOwnerAlreadyTyped() async throws {
        let (model, server) = try makeModel()
        let idea = try TestData.idea("aaaaaa", title: "追踪价格", brief: "每周看一次定价页。")
        model.composerText = "先说一件事"

        model.discuss(idea)

        XCTAssertEqual(model.composerText, "先说一件事\n\n关于想法「追踪价格」：\n每周看一次定价页。")
        XCTAssertEqual(server.requests(to: "/api/commands").count, 0)
    }

    func testUnpairingClearsTheComposer() async throws {
        let (model, _) = try makeModel()
        model.composerText = "还没发的话"
        model.unpair()
        XCTAssertEqual(model.composerText, "")
    }

    // MARK: Opening a task

    func testOpeningATaskShowsTheTasksTabWithARequestForItsDetail() async throws {
        let (model, _) = try makeModel()
        model.selectedTab = .ideas

        model.openTask(id: "tttttt")

        XCTAssertEqual(model.selectedTab, .tasks)
        XCTAssertEqual(model.taskOpenRequest?.taskId, "tttttt")
    }

    func testAHandledRequestGoesAndANewerOneStays() async throws {
        let (model, _) = try makeModel()
        model.openTask(id: "aaaaaa")
        let first = try XCTUnwrap(model.taskOpenRequest)
        model.openTask(id: "bbbbbb")
        let second = try XCTUnwrap(model.taskOpenRequest)
        XCTAssertNotEqual(first, second)

        model.taskOpenHandled(first)
        XCTAssertEqual(model.taskOpenRequest, second)
        model.taskOpenHandled(second)
        XCTAssertNil(model.taskOpenRequest)
    }
}
