import AlfredKit
import Foundation
import XCTest

final class TaskFixtureTests: XCTestCase {
    private func decodeEvent(_ name: String) throws -> Event {
        try JSONDecoder().decode(Event.self, from: Data(contentsOf: Fixtures.directory.appending(path: name)))
    }

    private func date(_ text: String) throws -> Date {
        try Date.ISO8601FormatStyle().parse(text)
    }

    func testDailyTaskFieldsAreDecoded() throws {
        let event = try decodeEvent("events/task-updated-daily.json")
        guard case let .taskUpdated(task) = event.payload else {
            return XCTFail("expected a task.updated event, got \(event.payload)")
        }
        XCTAssertEqual(task.id, "p3r8vx")
        XCTAssertEqual(task.title, "每日 VPS 价格")
        XCTAssertEqual(task.origin, .manual)
        XCTAssertEqual(task.schedule, .daily(time: TimeOfDay(hour: 9, minute: 0)))
        XCTAssertEqual(task.status, .active)
        XCTAssertEqual(task.model, .sonnet)
        XCTAssertEqual(task.budgetUsd, 2)
        XCTAssertEqual(task.nextRunAt, try date("2026-10-27T01:00:00Z"))
        XCTAssertEqual(task.lastRunId, "b4n7cj")
        XCTAssertEqual(task.lastRunAt, try date("2026-10-26T01:00:00Z"))
        XCTAssertEqual(task.skips, [])
    }

    func testPausedWeeklyTaskHasNoNextRunAndKeepsItsDailyCapSkip() throws {
        let event = try decodeEvent("events/task-updated-weekly-paused.json")
        guard case let .taskUpdated(task) = event.payload else {
            return XCTFail("expected a task.updated event, got \(event.payload)")
        }
        XCTAssertEqual(task.origin, .chat)
        XCTAssertEqual(task.schedule, .weekly(days: [1, 3, 5], time: TimeOfDay(hour: 8, minute: 30)))
        XCTAssertEqual(task.status, .paused)
        XCTAssertNil(task.nextRunAt)
        XCTAssertEqual(task.model, .opus)
        XCTAssertEqual(task.skips.map(\.reason), [.dailyCap])
        XCTAssertEqual(task.skips.first?.at, try date("2026-10-19T00:30:00Z"))
    }

    func testOnceTaskIsDoneAfterItsMissedSkip() throws {
        let event = try decodeEvent("events/task-updated-once-done.json")
        guard case let .taskUpdated(task) = event.payload else {
            return XCTFail("expected a task.updated event, got \(event.payload)")
        }
        XCTAssertEqual(task.schedule, .once(at: try date("2026-10-25T05:00:00Z")))
        XCTAssertEqual(task.status, .done)
        XCTAssertNil(task.nextRunAt)
        XCTAssertEqual(task.skips.map(\.reason), [.missed])
    }

    func testIntervalTaskDecodesItsHours() throws {
        let event = try decodeEvent("events/task-updated-interval.json")
        guard case let .taskUpdated(task) = event.payload else {
            return XCTFail("expected a task.updated event, got \(event.payload)")
        }
        XCTAssertEqual(task.schedule, .interval(hours: 6))
        XCTAssertEqual(task.origin, .idea)
    }

    func testRunAndMessageNameTheirTask() throws {
        guard case let .runUpdated(run) = try decodeEvent("events/run-updated-task.json").payload else {
            return XCTFail("expected a run.updated event")
        }
        XCTAssertEqual(run.taskId, "p3r8vx")
        guard case let .messageCreated(message) = try decodeEvent("events/message-created-task-delivery.json").payload else {
            return XCTFail("expected a message.created event")
        }
        XCTAssertEqual(message.taskId, "p3r8vx")
        XCTAssertEqual(message.runId, "b4n7cj")
    }

    func testTaskListCarriesItsTimeZoneAndTasks() throws {
        let data = try Data(contentsOf: Fixtures.directory.appending(path: "responses/task-list.json"))
        let list = try JSONDecoder().decode(TaskList.self, from: data)
        XCTAssertEqual(list.timeZone, "Asia/Taipei")
        XCTAssertEqual(list.tasks.map(\.id), ["y9d4kx", "n2c7bq", "p3r8vx", "t5w2hf"])
    }

    func testTaskDetailHasItsRunsOfTheTask() throws {
        let data = try Data(contentsOf: Fixtures.directory.appending(path: "responses/task-detail.json"))
        let detail = try JSONDecoder().decode(TaskDetail.self, from: data)
        XCTAssertEqual(detail.task.id, "p3r8vx")
        XCTAssertEqual(detail.runs.map(\.id), ["b4n7cj", "h8q3tn"])
        XCTAssertEqual(detail.runs.map(\.taskId), ["p3r8vx", "p3r8vx"])
    }

    func testTaskCreateCarriesItsDraft() throws {
        let command = try decodeCommand("commands/task-create.json")
        XCTAssertEqual(
            command,
            .taskCreate(TaskDraft(
                title: "每周供应商动态",
                brief: "看三家供应商的博客和状态页，列出本周的变化。",
                schedule: .weekly(days: [1, 3, 5], time: TimeOfDay(hour: 8, minute: 30)),
                model: .opus,
                budgetUsd: 5
            ))
        )
        guard case let .taskCreate(minimal) = try decodeCommand("commands/task-create-minimal.json") else {
            return XCTFail("expected task.create")
        }
        XCTAssertNil(minimal.model)
        XCTAssertNil(minimal.budgetUsd)
    }

    func testTaskUpdateSendsOnlyTheFieldsItChanges() throws {
        let command = try decodeCommand("commands/task-update-pause.json")
        XCTAssertEqual(command, .taskUpdate(taskId: "p3r8vx", changes: TaskChanges(status: .paused)))
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(command)) as? [String: Any])
        XCTAssertEqual(json.keys.sorted(), ["status", "taskId", "type"])
        XCTAssertEqual(json["status"] as? String, "paused")
    }

    func testTaskRunCarriesTheTaskId() throws {
        XCTAssertEqual(try decodeCommand("commands/task-run.json"), .taskRun(taskId: "p3r8vx"))
    }

    func testTimeOfDayCodesAsHHMM() throws {
        let time = try JSONDecoder().decode(TimeOfDay.self, from: Data(#""09:05""#.utf8))
        XCTAssertEqual(time, TimeOfDay(hour: 9, minute: 5))
        XCTAssertEqual(try JSONDecoder().decode(TimeOfDay.self, from: Data(#""00:00""#.utf8)), TimeOfDay(hour: 0, minute: 0))
        XCTAssertEqual(try JSONDecoder().decode(TimeOfDay.self, from: Data(#""23:59""#.utf8)), TimeOfDay(hour: 23, minute: 59))
        XCTAssertEqual(String(decoding: try JSONEncoder().encode(time), as: UTF8.self), #""09:05""#)
    }

    func testMalformedTimesOfDayFailToDecode() {
        for text in ["24:00", "9:00", "12:60", "12:5", "1200", "12:00:00", "", "١٢:00"] {
            XCTAssertThrowsError(try JSONDecoder().decode(TimeOfDay.self, from: Data("\"\(text)\"".utf8)), text)
        }
    }

    func testAScheduleOfAnUnknownKindDoesNotDecode() {
        let json = Data(#"{"kind":"cron","expression":"0 9 * * *"}"#.utf8)
        XCTAssertThrowsError(try JSONDecoder().decode(Schedule.self, from: json))
    }

    func testAOnceScheduleRoundTripsItsTimestamp() throws {
        let schedule = Schedule.once(at: try date("2026-10-25T05:00:00Z"))
        let encoded = try JSONEncoder().encode(schedule)
        XCTAssertEqual(try JSONDecoder().decode(Schedule.self, from: encoded), schedule)
    }

    private func decodeCommand(_ name: String) throws -> Command {
        try JSONDecoder().decode(Command.self, from: Data(contentsOf: Fixtures.directory.appending(path: name)))
    }
}
