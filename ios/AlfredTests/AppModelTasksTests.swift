import AlfredKit
import XCTest

@testable import Alfred

/// The app's tasks: kept current by `task.updated` events, loaded from `GET /api/tasks`, and changed by commands.
@MainActor
final class AppModelTasksTests: XCTestCase {
    /// A paired model on a fake server whose event stream is scripted: `updates` arrive in order, and the stream stays
    /// open. `list` answers `GET /api/tasks` in turn, `commands` answers `POST /api/commands`.
    private func makeModel(
        updates: [EventStreamUpdate] = [],
        list: [StubReply] = [],
        commands: [StubReply] = [StubReply(status: 202)]
    ) throws -> (AppModel, StubServer) {
        let listScript = ReplyScript(list.isEmpty ? [try emptyList()] : list)
        let commandScript = ReplyScript(commands)
        let server = StubServer { request in
            switch request.url?.path ?? "" {
            case "/api/tasks": return listScript.next()
            case "/api/commands": return commandScript.next()
            default: return StubReply(status: 404)
            }
        }
        let model = AppModel(
            store: InMemoryCredentialStore(try server.credentials()),
            session: server.session,
            openStream: { _, _ in AsyncStream { continuation in updates.forEach { continuation.yield($0) } } }
        )
        addTeardownBlock { @MainActor in
            model.background()
            withExtendedLifetime(server) {}
        }
        return (model, server)
    }

    private func emptyList() throws -> StubReply {
        StubReply(chunks: [try TestData.taskList([])])
    }

    private func tasks(_ objects: [[String: Any]]) throws -> StubReply {
        StubReply(chunks: [try TestData.taskList(objects)])
    }

    private func result(_ task: [String: Any], status: Int = 200) throws -> StubReply {
        StubReply(status: status, chunks: [try JSONSerialization.data(withJSONObject: ["task": task])])
    }

    private func error(_ message: String, status: Int = 400) -> StubReply {
        StubReply(status: status, chunks: [Data(#"{"error":"\#(message)"}"#.utf8)])
    }

    private func event(_ id: Int, _ task: [String: Any]) throws -> EventStreamUpdate {
        .received(try TestData.streamEvent(TestData.taskEvent(id, task: task)))
    }

    // MARK: Events

    func testTaskUpdatedEventsAddAndChangeTasks() async throws {
        let (model, _) = try makeModel(updates: [
            try event(1, TestData.taskObject("aaaaaa", title: "旧标题")),
            try event(2, TestData.taskObject("aaaaaa", title: "新标题", updatedAt: "2026-10-26T09:00:00.000Z")),
            try event(3, TestData.taskObject("bbbbbb", title: "另一个", createdAt: "2026-10-26T10:00:00.000Z")),
        ])
        model.foreground()

        await eventually { model.taskCatalog.open.count == 2 }
        XCTAssertEqual(model.taskCatalog.open.map(\.title), ["另一个", "新标题"])
        XCTAssertEqual(model.timeline.lastEventId, 3, "the timeline still moves its resume point past task events")
    }

    func testATaskThatEndsMovesToTheEndedGroup() async throws {
        let (model, _) = try makeModel(updates: [
            try event(1, TestData.taskObject("aaaaaa")),
            try event(2, TestData.taskObject("aaaaaa", status: "done", updatedAt: "2026-10-26T09:00:00.000Z")),
        ])
        model.foreground()

        await eventually { model.taskCatalog.ended.count == 1 }
        XCTAssertEqual(model.taskCatalog.open, [])
    }

    // MARK: Loading

    func testTheListIsLoadedWhenTheStreamConnects() async throws {
        let (model, server) = try makeModel(
            updates: [.connected],
            list: [try tasks([TestData.taskObject("aaaaaa", title: "每日简报")])]
        )
        model.foreground()

        await eventually { model.taskCatalog.hasLoaded }
        XCTAssertEqual(model.taskCatalog.open.map(\.title), ["每日简报"])
        XCTAssertEqual(model.taskCatalog.timeZone, "Asia/Taipei")
        XCTAssertEqual(server.requests(to: "/api/tasks").count, 1)
    }

    func testTheListIsLoadedAgainWhenTheStreamResumes() async throws {
        let (model, server) = try makeModel(
            updates: [.connected, .disconnected, .connected],
            list: [try tasks([TestData.taskObject("aaaaaa")]), try tasks([TestData.taskObject("aaaaaa"), TestData.taskObject("bbbbbb")])]
        )
        model.foreground()

        await eventually { server.requests(to: "/api/tasks").count == 2 }
        await eventually { model.taskCatalog.open.count == 2 }
    }

    func testALoadedListDoesNotUndoANewerEvent() async throws {
        let (model, server) = try makeModel(
            updates: [try event(1, TestData.taskObject("aaaaaa", title: "新标题", updatedAt: "2026-10-26T10:00:00.000Z")), .connected],
            list: [try tasks([TestData.taskObject("aaaaaa", title: "旧标题", updatedAt: "2026-10-26T09:00:00.000Z")])]
        )
        model.foreground()

        await eventually { model.taskCatalog.hasLoaded }
        XCTAssertEqual(server.requests(to: "/api/tasks").count, 1)
        XCTAssertEqual(model.taskCatalog.task(id: "aaaaaa")?.title, "新标题")
    }

    func testAFailedLoadSaysWhyWithoutAnAlertAndKeepsTheTasks() async throws {
        let (model, _) = try makeModel(
            updates: [try event(1, TestData.taskObject("aaaaaa"))],
            list: [error("bad gateway", status: 502), try tasks([TestData.taskObject("aaaaaa")])]
        )
        model.foreground()
        await eventually { model.taskCatalog.open.count == 1 }

        await model.refreshTasks()
        XCTAssertEqual(model.taskFailure, "服务器返回 502：bad gateway")
        XCTAssertNil(model.actionFailure)
        XCTAssertEqual(model.taskCatalog.open.count, 1)

        await model.refreshTasks()
        XCTAssertNil(model.taskFailure)
    }

    // MARK: Commands

    func testCreatingATaskSendsItAndShowsTheResult() async throws {
        let created = TestData.taskObject("aaaaaa", title: "每日简报", model: "haiku", budgetUsd: 0.3)
        let (model, server) = try makeModel(commands: [try result(created, status: 201)])

        try await model.createTask(TaskDraft(
            title: "每日简报", brief: "写一份简报", schedule: .daily(time: TimeOfDay(hour: 8, minute: 0)), model: .haiku, budgetUsd: 0.3
        ))

        let sent = try XCTUnwrap(server.requests(to: "/api/commands").first?.chatCommand)
        XCTAssertEqual(sent["type"] as? String, "task.create")
        XCTAssertEqual(sent["title"] as? String, "每日简报")
        XCTAssertEqual(sent["model"] as? String, "haiku")
        XCTAssertEqual(sent["budgetUsd"] as? Double, 0.3)
        XCTAssertEqual(sent["schedule"] as? [String: String], ["kind": "daily", "time": "08:00"])
        XCTAssertEqual(model.taskCatalog.open.map(\.id), ["aaaaaa"], "the task is listed without waiting for its event")
    }

    func testARejectedCreateThrowsTheServersMessageAndListsNothing() async throws {
        let (model, _) = try makeModel(commands: [error("that time has passed")])
        do {
            try await model.createTask(TaskDraft(title: "x", brief: "y", schedule: .daily(time: TimeOfDay(hour: 8, minute: 0))))
            XCTFail("a rejected create should throw")
        } catch {
            XCTAssertEqual(LoadFailure.commandMessage(for: error), "that time has passed")
        }
        XCTAssertEqual(model.taskCatalog.open, [])
        XCTAssertNil(model.actionFailure, "the form shows the failure, not an alert")
    }

    func testUpdatingATaskSendsOnlyTheChangesAndShowsTheResult() async throws {
        let paused = TestData.taskObject("aaaaaa", status: "paused", updatedAt: "2026-10-26T09:00:00.000Z")
        let (model, server) = try makeModel(
            updates: [try event(1, TestData.taskObject("aaaaaa"))],
            commands: [try result(paused)]
        )
        model.foreground()
        await eventually { model.taskCatalog.open.count == 1 }

        try await model.updateTask(id: "aaaaaa", changes: TaskChanges(status: .paused))

        let sent = try XCTUnwrap(server.requests(to: "/api/commands").first?.chatCommand)
        XCTAssertEqual(Set(sent.keys), ["type", "taskId", "status"])
        XCTAssertEqual(sent["status"] as? String, "paused")
        XCTAssertEqual(model.taskCatalog.task(id: "aaaaaa")?.status, .paused)
    }

    func testARejectedUpdateThrowsAndKeepsTheTask() async throws {
        let (model, _) = try makeModel(
            updates: [try event(1, TestData.taskObject("aaaaaa"))],
            commands: [error("no task aaaaaa", status: 404)]
        )
        model.foreground()
        await eventually { model.taskCatalog.open.count == 1 }

        do {
            try await model.updateTask(id: "aaaaaa", changes: TaskChanges(title: "x"))
            XCTFail("a rejected update should throw")
        } catch {
            XCTAssertEqual(LoadFailure.commandMessage(for: error), "no task aaaaaa")
        }
        XCTAssertEqual(model.taskCatalog.task(id: "aaaaaa")?.status, .active)
    }

    func testRunningATaskPostsTaskRun() async throws {
        let (model, server) = try makeModel()
        try await model.runTask(id: "aaaaaa")
        let sent = try XCTUnwrap(server.requests(to: "/api/commands").first?.chatCommand)
        XCTAssertEqual(sent as? [String: String], ["type": "task.run", "taskId": "aaaaaa"])
    }

    func testARefusedTaskCommandShowsTheAccessError() async throws {
        let (model, _) = try makeModel(commands: [StubReply(status: 401)])
        do {
            try await model.runTask(id: "aaaaaa")
            XCTFail("a refused command should throw")
        } catch {
            XCTAssertEqual(error as? AlfredError, .unauthorized)
        }
        XCTAssertEqual(model.streamFailure, .unauthorized)
    }

    // MARK: The rest of the app

    func testUnpairingForgetsTheTasks() async throws {
        let (model, _) = try makeModel(updates: [try event(1, TestData.taskObject("aaaaaa"))])
        model.foreground()
        await eventually { model.taskCatalog.open.count == 1 }

        model.unpair()

        XCTAssertEqual(model.taskCatalog, TaskCatalog())
        XCTAssertNil(model.taskFailure)
    }

    func testTheChatLabelsAMessageWithItsTasksTitle() async throws {
        let (model, _) = try makeModel(updates: [try event(1, TestData.taskObject("aaaaaa", title: "每日简报"))])
        model.foreground()
        await eventually { model.taskCatalog.open.count == 1 }

        XCTAssertEqual(model.taskLabel(for: try TestData.message("m1", taskId: "aaaaaa")), "每日简报")
        XCTAssertNil(model.taskLabel(for: try TestData.message("m2", taskId: "zzzzzz")))
    }
}
