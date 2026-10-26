import AlfredKit
import XCTest

@testable import Alfred

final class TaskCatalogTests: XCTestCase {
    private func catalog(_ tasks: [[String: Any]], zone: String = "Asia/Taipei") throws -> TaskCatalog {
        var catalog = TaskCatalog()
        catalog.load(try JSONDecoder().decode(TaskList.self, from: TestData.taskList(zone: zone, tasks)))
        return catalog
    }

    // MARK: Grouping and order

    func testActiveAndPausedTasksAreListedTogetherNewestCreatedFirst() throws {
        let catalog = try catalog([
            TestData.taskObject("aaaaaa", createdAt: "2026-10-24T08:00:00.000Z"),
            TestData.taskObject("bbbbbb", status: "paused", createdAt: "2026-10-25T08:00:00.000Z"),
            TestData.taskObject("cccccc", createdAt: "2026-10-26T08:00:00.000Z"),
        ])
        XCTAssertEqual(catalog.open.map(\.id), ["cccccc", "bbbbbb", "aaaaaa"])
        XCTAssertEqual(catalog.ended, [])
    }

    func testEndedTasksAreGroupedApartAndNewestCreatedFirst() throws {
        let catalog = try catalog([
            TestData.taskObject("aaaaaa", status: "done", createdAt: "2026-10-24T08:00:00.000Z"),
            TestData.taskObject("bbbbbb", createdAt: "2026-10-25T08:00:00.000Z"),
            TestData.taskObject("cccccc", status: "done", createdAt: "2026-10-26T08:00:00.000Z"),
        ])
        XCTAssertEqual(catalog.open.map(\.id), ["bbbbbb"])
        XCTAssertEqual(catalog.ended.map(\.id), ["cccccc", "aaaaaa"])
    }

    func testTasksCreatedTogetherKeepAStableOrder() throws {
        let catalog = try catalog([TestData.taskObject("bbbbbb"), TestData.taskObject("aaaaaa")])
        XCTAssertEqual(catalog.open.map(\.id), ["aaaaaa", "bbbbbb"])
    }

    func testAStatusThisAppDoesNotKnowCountsAsOpen() throws {
        let catalog = try catalog([TestData.taskObject("aaaaaa", status: "archived")])
        XCTAssertEqual(catalog.open.map(\.id), ["aaaaaa"])
    }

    func testLoadingKeepsTheZoneTheSchedulesAreIn() throws {
        let loaded = try catalog([], zone: "Asia/Taipei")
        XCTAssertEqual(loaded.timeZone, "Asia/Taipei")
        XCTAssertTrue(loaded.hasLoaded)
        XCTAssertNil(TaskCatalog().timeZone)
        XCTAssertFalse(TaskCatalog().hasLoaded)
    }

    // MARK: task.updated events

    func testANewTaskAppears() throws {
        var catalog = try catalog([TestData.taskObject("aaaaaa")])
        catalog.apply(try TestData.streamEvent(TestData.taskEvent(7, task: TestData.taskObject("bbbbbb", title: "新任务", createdAt: "2026-10-27T08:00:00.000Z"))))
        XCTAssertEqual(catalog.open.map(\.id), ["bbbbbb", "aaaaaa"])
        XCTAssertEqual(catalog.task(id: "bbbbbb")?.title, "新任务")
    }

    func testAChangedTaskUpdatesInPlace() throws {
        var catalog = try catalog([TestData.taskObject("aaaaaa", title: "旧标题")])
        let changed = TestData.taskObject("aaaaaa", title: "新标题", status: "paused", updatedAt: "2026-10-26T09:00:00.000Z")
        catalog.apply(try TestData.streamEvent(TestData.taskEvent(8, task: changed)))
        XCTAssertEqual(catalog.open.map(\.title), ["新标题"])
        XCTAssertEqual(catalog.task(id: "aaaaaa")?.status, .paused)
        XCTAssertNil(catalog.task(id: "aaaaaa")?.nextRunAt)
    }

    func testATaskThatEndsMovesToTheEndedGroup() throws {
        var catalog = try catalog([TestData.taskObject("aaaaaa"), TestData.taskObject("bbbbbb", createdAt: "2026-10-25T08:00:00.000Z")])
        let ended = TestData.taskObject("aaaaaa", status: "done", updatedAt: "2026-10-26T09:00:00.000Z")
        catalog.apply(try TestData.streamEvent(TestData.taskEvent(9, task: ended)))
        XCTAssertEqual(catalog.open.map(\.id), ["bbbbbb"])
        XCTAssertEqual(catalog.ended.map(\.id), ["aaaaaa"])
    }

    func testOtherEventsChangeNothing() throws {
        var catalog = try catalog([TestData.taskObject("aaaaaa")])
        let before = catalog
        catalog.apply(try TestData.streamEvent(TestData.runEvent(3, run: TestData.runObject("rrrrrr"), at: "2026-10-26T08:00:00.000Z")))
        catalog.apply(try TestData.streamEvent(TestData.messageEvent(4, id: "m1", direction: "out", text: "hi", at: "2026-10-26T08:00:00.000Z")))
        XCTAssertEqual(catalog, before)
    }

    func testAnOlderVersionOfATaskIsIgnored() throws {
        var catalog = try catalog([TestData.taskObject("aaaaaa", title: "新", updatedAt: "2026-10-26T10:00:00.000Z")])
        let older = TestData.taskObject("aaaaaa", title: "旧", updatedAt: "2026-10-26T09:00:00.000Z")
        catalog.apply(try TestData.streamEvent(TestData.taskEvent(2, task: older)))
        XCTAssertEqual(catalog.task(id: "aaaaaa")?.title, "新", "a replayed event must not undo a newer version")
    }

    func testALoadMergesWithWhatEventsAlreadyTold() throws {
        var catalog = TaskCatalog()
        // The stream was quicker than the request: it told of a new task and of a change.
        catalog.apply(try TestData.streamEvent(TestData.taskEvent(1, task: TestData.taskObject("aaaaaa", title: "事件里的", updatedAt: "2026-10-26T10:00:00.000Z"))))
        catalog.apply(try TestData.streamEvent(TestData.taskEvent(2, task: TestData.taskObject("cccccc", createdAt: "2026-10-26T11:00:00.000Z"))))

        catalog.load(try JSONDecoder().decode(TaskList.self, from: TestData.taskList([
            TestData.taskObject("aaaaaa", title: "列表里的", updatedAt: "2026-10-26T09:00:00.000Z"),
            TestData.taskObject("bbbbbb", createdAt: "2026-10-25T08:00:00.000Z"),
        ])))

        XCTAssertEqual(catalog.task(id: "aaaaaa")?.title, "事件里的")
        XCTAssertEqual(Set(catalog.open.map(\.id)), ["aaaaaa", "bbbbbb", "cccccc"], "a task only the stream knows is kept: tasks are never removed")
    }

    // MARK: The chat label

    func testAnOutboundMessageOfAKnownTaskIsLabelledWithItsTitle() throws {
        let catalog = try catalog([TestData.taskObject("aaaaaa", title: "每日 VPS 价格")])
        XCTAssertEqual(catalog.label(for: try TestData.message("m1", taskId: "aaaaaa")), "每日 VPS 价格")
    }

    func testAMessageOfAnUnknownTaskHasNoLabel() throws {
        let catalog = try catalog([TestData.taskObject("aaaaaa")])
        XCTAssertNil(catalog.label(for: try TestData.message("m1", taskId: "zzzzzz")))
        XCTAssertNil(TaskCatalog().label(for: try TestData.message("m1", taskId: "aaaaaa")))
    }

    func testAMessageWithoutATaskHasNoLabel() throws {
        let catalog = try catalog([TestData.taskObject("aaaaaa")])
        XCTAssertNil(catalog.label(for: try TestData.message("m1")))
    }

    func testTheOwnersMessageHasNoLabel() throws {
        let catalog = try catalog([TestData.taskObject("aaaaaa")])
        XCTAssertNil(catalog.label(for: try TestData.message("m1", direction: "in", taskId: "aaaaaa")))
    }

    func testTheLabelFollowsATitleThatChanged() throws {
        var catalog = try catalog([TestData.taskObject("aaaaaa", title: "旧标题")])
        catalog.apply(try TestData.streamEvent(TestData.taskEvent(5, task: TestData.taskObject("aaaaaa", title: "新标题", updatedAt: "2026-10-26T09:00:00.000Z"))))
        XCTAssertEqual(catalog.label(for: try TestData.message("m1", taskId: "aaaaaa")), "新标题")
    }
}
