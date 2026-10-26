import AlfredKit
import XCTest

@testable import Alfred

final class TaskPresentationTests: XCTestCase {
    func testStatusLabels() {
        XCTAssertEqual(TaskPresentation.statusLabel(.active), "已启用")
        XCTAssertEqual(TaskPresentation.statusLabel(.paused), "已暂停")
        XCTAssertEqual(TaskPresentation.statusLabel(.done), "已结束")
        XCTAssertEqual(TaskPresentation.statusLabel(TaskStatus(rawValue: "archived")), "archived", "a status this app does not know shows as the server sent it")
    }

    func testOriginLabels() {
        XCTAssertEqual(TaskPresentation.originLabel(.manual), "手动")
        XCTAssertEqual(TaskPresentation.originLabel(.chat), "对话")
        XCTAssertEqual(TaskPresentation.originLabel(.idea), "想法")
        XCTAssertEqual(TaskPresentation.originLabel(TaskOrigin(rawValue: "import")), "import")
    }

    func testSkipReasonsAreInWords() {
        XCTAssertEqual(TaskPresentation.skipReason(.missed), "错过（Alfred 当时未运行）")
        XCTAssertEqual(TaskPresentation.skipReason(.dailyCap), "已达每日上限")
        XCTAssertEqual(TaskPresentation.skipReason(TaskSkip.Reason(rawValue: "other")), "other")
    }

    func testTheNextRunIsADateAndATimeFromNow() throws {
        let taipei = try XCTUnwrap(TimeZone(identifier: "Asia/Taipei"))
        let date = Date(timeIntervalSinceNow: 5 * 3600 + 30)
        let text = TaskPresentation.nextRun(date, in: taipei)
        XCTAssertTrue(text.hasSuffix("（5小时后）"), text)
        XCTAssertTrue(text.contains(":"), text)
    }

    func testTheStatusButtonPausesAnActiveTaskAndResumesAPausedOrEndedOne() throws {
        let active = try TestData.task("aaaaaa")
        let paused = try TestData.task("bbbbbb", status: "paused")
        let done = try TestData.task("cccccc", status: "done")
        let unknown = try TestData.task("dddddd", status: "archived")
        XCTAssertEqual(TaskPresentation.toggle(active)?.label, "暂停")
        XCTAssertEqual(TaskPresentation.toggle(active)?.status, .paused)
        XCTAssertEqual(TaskPresentation.toggle(paused)?.label, "恢复")
        XCTAssertEqual(TaskPresentation.toggle(paused)?.status, .active)
        XCTAssertEqual(TaskPresentation.toggle(done)?.label, "恢复")
        XCTAssertEqual(TaskPresentation.toggle(done)?.status, .active)
        XCTAssertNil(TaskPresentation.toggle(unknown), "a status this app does not know offers no status button")
    }

    func testOnlyUnendedTasksCanBeEnded() throws {
        XCTAssertTrue(TaskPresentation.canEnd(try TestData.task("aaaaaa")))
        XCTAssertTrue(TaskPresentation.canEnd(try TestData.task("bbbbbb", status: "paused")))
        XCTAssertFalse(TaskPresentation.canEnd(try TestData.task("cccccc", status: "done")))
    }

    func testTheCapShowsTwoDecimalsAsTheOwnerSetsIt() {
        XCTAssertEqual(TaskPresentation.cap(0.3), "$0.30")
        XCTAssertEqual(TaskPresentation.cap(2), "$2.00")
    }
}
