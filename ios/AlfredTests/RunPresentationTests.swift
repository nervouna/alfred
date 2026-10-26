import AlfredKit
import XCTest

@testable import Alfred

final class RunPresentationTests: XCTestCase {
    func testStatusLabels() {
        XCTAssertEqual(RunPresentation.statusLabel(.queued), "排队中")
        XCTAssertEqual(RunPresentation.statusLabel(.running), "进行中")
        XCTAssertEqual(RunPresentation.statusLabel(.done), "完成")
        XCTAssertEqual(RunPresentation.statusLabel(.stopped), "已停止")
        XCTAssertEqual(RunPresentation.statusLabel(.failed), "失败")
        XCTAssertEqual(RunPresentation.statusLabel(.lost), "中断")
        XCTAssertEqual(RunPresentation.statusLabel(RunStatus(rawValue: "paused")), "paused", "a status this app does not know shows as the server sent it")
    }

    func testAShortModelNameDropsTheVendorPrefix() {
        XCTAssertEqual(RunPresentation.modelName("claude-haiku-5-5"), "haiku-5-5")
        XCTAssertEqual(RunPresentation.modelName("other-model"), "other-model")
        XCTAssertNil(RunPresentation.modelName(nil))
        XCTAssertNil(RunPresentation.modelName(""))
    }

    func testCostShowsThreeDecimalsUnderADollarAndTwoFromADollarUp() {
        XCTAssertEqual(RunPresentation.cost(0), "$0.000")
        XCTAssertEqual(RunPresentation.cost(0.0004), "$0.000")
        XCTAssertEqual(RunPresentation.cost(0.0029), "$0.003")
        XCTAssertEqual(RunPresentation.cost(0.5), "$0.500")
        XCTAssertEqual(RunPresentation.cost(1), "$1.00")
        XCTAssertEqual(RunPresentation.cost(12.345), "$12.35")
    }

    func testStartTimeIsRelative() {
        XCTAssertEqual(RunPresentation.relative(Date(timeIntervalSinceNow: -300)), "5分钟前")
        XCTAssertEqual(RunPresentation.relative(Date(timeIntervalSinceNow: -3 * 3600)), "3小时前")
    }

    // MARK: Which runs the list shows

    func testTheListTakesAStatusTheTimelineKnows() throws {
        let loaded = [try TestData.run("r1", status: "running")]
        let timeline = try TestData.timeline([
            TestData.runEvent(1, run: TestData.runObject("r1", status: "done", endedAt: "2026-10-26T08:05:00.000Z"), at: "2026-10-26T08:05:00.000Z"),
        ])
        let runs = RunPresentation.merged(loaded: loaded, timeline: timeline)
        XCTAssertEqual(runs.map(\.status), [.done])
    }

    func testAnEndedRunIsNotReopenedByAnEarlierTimeline() throws {
        // The list was loaded after the run ended, while the stream was still catching up.
        let loaded = [try TestData.run("r1", status: "done", endedAt: "2026-10-26T08:05:00.000Z")]
        let timeline = try TestData.timeline([
            TestData.runEvent(1, run: TestData.runObject("r1", status: "running"), at: "2026-10-26T08:00:00.000Z"),
        ])
        XCTAssertEqual(RunPresentation.merged(loaded: loaded, timeline: timeline).map(\.status), [.done])
    }

    func testARunOnlyTheTimelineKnowsIsListed() throws {
        let loaded = [try TestData.run("r1", startedAt: "2026-10-26T08:00:00.000Z")]
        let timeline = try TestData.timeline([
            TestData.runEvent(1, run: TestData.runObject("r2", status: "running", startedAt: "2026-10-26T09:00:00.000Z"), at: "2026-10-26T09:00:00.000Z"),
        ])
        XCTAssertEqual(RunPresentation.merged(loaded: loaded, timeline: timeline).map(\.id), ["r2", "r1"])
    }

    func testTheListIsNewestFirst() throws {
        let loaded = [
            try TestData.run("old", startedAt: "2026-10-25T08:00:00.000Z"),
            try TestData.run("new", startedAt: "2026-10-26T08:00:00.000Z"),
            try TestData.run("mid", startedAt: "2026-10-25T20:00:00.000Z"),
        ]
        XCTAssertEqual(RunPresentation.merged(loaded: loaded, timeline: Timeline()).map(\.id), ["new", "mid", "old"])
    }

    func testRunsStartedTogetherKeepAStableOrder() throws {
        let loaded = [try TestData.run("b"), try TestData.run("a")]
        XCTAssertEqual(RunPresentation.merged(loaded: loaded, timeline: Timeline()).map(\.id), ["a", "b"])
    }

    func testOnlyUnfinishedRunsCanBeStopped() throws {
        XCTAssertTrue(RunPresentation.canStop(try TestData.run("r", status: "running")))
        XCTAssertFalse(RunPresentation.canStop(try TestData.run("r", status: "queued")))
        XCTAssertFalse(RunPresentation.canStop(try TestData.run("r", status: "done")))
        XCTAssertFalse(RunPresentation.canStop(try TestData.run("r", status: "lost")))
    }
}
