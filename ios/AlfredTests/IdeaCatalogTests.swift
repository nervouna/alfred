import AlfredKit
import XCTest

@testable import Alfred

final class IdeaCatalogTests: XCTestCase {
    private func catalog(_ ideas: [[String: Any]], generatingRunId: String? = nil) throws -> IdeaCatalog {
        var catalog = IdeaCatalog()
        catalog.load(try TestData.decodedIdeaList(ideas, generatingRunId: generatingRunId))
        return catalog
    }

    private func event(_ id: Int, _ idea: [String: Any]) throws -> StreamEvent {
        try TestData.streamEvent(TestData.ideaEvent(id, idea: idea))
    }

    // MARK: Loading and order

    func testALoadedListMarksTheCatalogLoadedAndHoldsItsIdeas() throws {
        XCTAssertFalse(IdeaCatalog().hasLoaded)
        let loaded = try catalog([TestData.ideaObject("aaaaaa"), TestData.ideaObject("bbbbbb")])
        XCTAssertTrue(loaded.hasLoaded)
        XCTAssertEqual(loaded.ids, ["aaaaaa", "bbbbbb"])
        XCTAssertEqual(loaded.idea(id: "aaaaaa")?.title, "盯住供应商状态页")
        XCTAssertNil(loaded.idea(id: "zzzzzz"))
    }

    func testOpenIdeasAreNewestCreatedFirstAndTheRestAreHistory() throws {
        let loaded = try catalog([
            TestData.ideaObject("aaaaaa", createdAt: "2026-10-25T01:00:00.000Z"),
            TestData.ideaObject("bbbbbb", createdAt: "2026-10-27T01:00:00.000Z"),
            TestData.ideaObject("cccccc", createdAt: "2026-10-26T01:00:00.000Z"),
            TestData.ideaObject("dddddd", state: "rejected", rejection: ["reason": "not-now"]),
        ])
        XCTAssertEqual(loaded.open.map(\.id), ["bbbbbb", "cccccc", "aaaaaa"])
        XCTAssertEqual(loaded.history.map(\.id), ["dddddd"])
    }

    func testIdeasCreatedTogetherKeepAStableOrder() throws {
        let loaded = try catalog([TestData.ideaObject("bbbbbb"), TestData.ideaObject("aaaaaa")])
        XCTAssertEqual(loaded.open.map(\.id), ["aaaaaa", "bbbbbb"])
    }

    func testHistoryHoldsAcceptedRejectedAndArchivedIdeasNewestUpdatedFirst() throws {
        let loaded = try catalog([
            TestData.ideaObject("aaaaaa", state: "archived", createdAt: "2026-10-20T01:00:00.000Z", updatedAt: "2026-10-27T01:00:00.000Z"),
            TestData.ideaObject(
                "bbbbbb", state: "accepted", taskId: "n2c7bq", createdAt: "2026-10-26T01:00:00.000Z", updatedAt: "2026-10-26T05:00:00.000Z"
            ),
            TestData.ideaObject(
                "cccccc", state: "rejected", rejection: ["reason": "too-expensive"],
                createdAt: "2026-10-21T01:00:00.000Z", updatedAt: "2026-10-26T09:00:00.000Z"
            ),
            TestData.ideaObject("dddddd"),
        ])
        XCTAssertEqual(loaded.history.map(\.id), ["aaaaaa", "cccccc", "bbbbbb"], "newest updated first, whatever the state")
        XCTAssertEqual(loaded.open.map(\.id), ["dddddd"])
    }

    func testAStateThisAppDoesNotKnowIsHistory() throws {
        let loaded = try catalog([TestData.ideaObject("aaaaaa", state: "snoozed")])
        XCTAssertEqual(loaded.open, [])
        XCTAssertEqual(loaded.history.map(\.id), ["aaaaaa"])
    }

    // MARK: Events

    func testAnIdeaUpdatedEventInsertsAnIdea() throws {
        var catalog = IdeaCatalog()
        catalog.apply(try event(1, TestData.ideaObject("aaaaaa", title: "一个想法")))
        XCTAssertEqual(catalog.open.map(\.title), ["一个想法"])
    }

    func testAnIdeaUpdatedEventReplacesTheIdeaWithTheSameId() throws {
        var catalog = try catalog([TestData.ideaObject("aaaaaa", title: "旧")])
        catalog.apply(try event(1, TestData.ideaObject(
            "aaaaaa", state: "rejected", rejection: ["reason": "not-now", "note": "晚点"], updatedAt: "2026-10-27T02:00:00.000Z"
        )))
        XCTAssertEqual(catalog.open, [])
        XCTAssertEqual(catalog.history.first?.rejection?.reason, .notNow)
    }

    func testANewIdeaGoesAheadOfOlderOnes() throws {
        var catalog = try catalog([TestData.ideaObject("aaaaaa", createdAt: "2026-10-26T01:00:00.000Z")])
        catalog.apply(try event(1, TestData.ideaObject("bbbbbb", createdAt: "2026-10-27T01:00:00.000Z")))
        XCTAssertEqual(catalog.open.map(\.id), ["bbbbbb", "aaaaaa"])
    }

    func testAListReadBeforeAnEventCannotUndoIt() throws {
        var catalog = IdeaCatalog()
        catalog.apply(try event(1, TestData.ideaObject("aaaaaa", state: "archived", updatedAt: "2026-10-27T03:00:00.000Z")))
        catalog.load(try TestData.decodedIdeaList([TestData.ideaObject("aaaaaa", updatedAt: "2026-10-27T01:00:00.000Z")]))
        XCTAssertEqual(catalog.open, [], "the older list does not reopen the idea")
        XCTAssertEqual(catalog.history.map(\.id), ["aaaaaa"])
    }

    func testEventsThatAreNotIdeasChangeNothing() throws {
        var catalog = try catalog([TestData.ideaObject("aaaaaa")])
        let before = catalog
        catalog.apply(try TestData.streamEvent(TestData.taskEvent(1, task: TestData.taskObject("tttttt"))))
        catalog.apply(try TestData.streamEvent([
            "at": "2026-10-27T01:00:00.000Z", "type": "run.step",
            "data": ["runId": "v7c2mb", "step": ["at": "2026-10-27T01:00:00.000Z", "tool": "Read", "detail": "x"]],
        ]))
        XCTAssertEqual(catalog, before)
    }

    // MARK: A generation under way

    func testNothingIsGeneratingUntilTheListOrARunSaysSo() throws {
        XCTAssertFalse(IdeaCatalog().isGenerating)
        XCTAssertFalse(try catalog([]).isGenerating)
    }

    func testTheListsGeneratingRunIdMeansAGenerationIsUnderWay() throws {
        XCTAssertTrue(try catalog([], generatingRunId: "c9t5hq").isGenerating)
    }

    func testAGenerationRunThatIsQueuedOrRunningIsUnderWay() throws {
        for status in ["queued", "running"] {
            var catalog = IdeaCatalog()
            catalog.apply(try TestData.generationEvent(1, run: "c9t5hq", status: status))
            XCTAssertTrue(catalog.isGenerating, status)
        }
    }

    func testAGenerationRunThatEndedIsNotUnderWay() throws {
        for status in ["done", "stopped", "failed", "lost", "paused"] {
            var catalog = IdeaCatalog()
            catalog.apply(try TestData.generationEvent(1, run: "c9t5hq", status: "running"))
            catalog.apply(try TestData.generationEvent(2, run: "c9t5hq", status: status))
            XCTAssertFalse(catalog.isGenerating, "a run that is \(status) is not generating")
        }
    }

    func testAGenerationStaysUnderWayUntilItsRunEnds() throws {
        var catalog = try catalog([], generatingRunId: "c9t5hq")
        catalog.apply(try TestData.generationEvent(1, run: "c9t5hq", status: "running"))
        XCTAssertTrue(catalog.isGenerating)
        catalog.apply(try TestData.generationEvent(2, run: "c9t5hq", status: "done"))
        XCTAssertFalse(catalog.isGenerating)
    }

    func testARunOfAnotherKindIsNotAGeneration() throws {
        var catalog = IdeaCatalog()
        catalog.apply(try TestData.streamEvent(TestData.runEvent(
            1, run: TestData.runObject("r1", status: "running"), at: "2026-10-27T01:00:00.000Z"
        )))
        XCTAssertFalse(catalog.isGenerating)
    }

    func testAListWithoutAGeneratingRunEndsAGenerationTheCatalogThoughtWasUnderWay() throws {
        var catalog = IdeaCatalog()
        catalog.apply(try TestData.generationEvent(1, run: "c9t5hq", status: "running"))
        catalog.load(try TestData.decodedIdeaList([]))
        XCTAssertFalse(catalog.isGenerating)
    }

    func testAListCannotRestartAGenerationTheEventsSawEnd() throws {
        var catalog = IdeaCatalog()
        catalog.apply(try TestData.generationEvent(1, run: "c9t5hq", status: "done"))
        catalog.load(try TestData.decodedIdeaList([], generatingRunId: "c9t5hq"))
        XCTAssertFalse(catalog.isGenerating, "the list was read before the run ended")
    }

    func testAnAcceptedGenerationIsUnderWayAtOnce() throws {
        var catalog = IdeaCatalog()
        catalog.noteGeneration(runId: "c9t5hq")
        XCTAssertTrue(catalog.isGenerating)
        catalog.apply(try TestData.generationEvent(1, run: "c9t5hq", status: "done"))
        XCTAssertFalse(catalog.isGenerating)
    }

    func testAnAcceptedGenerationThatAlreadyEndedIsNotUnderWay() throws {
        var catalog = IdeaCatalog()
        catalog.apply(try TestData.generationEvent(1, run: "c9t5hq", status: "done"))
        catalog.noteGeneration(runId: "c9t5hq")
        XCTAssertFalse(catalog.isGenerating, "the end came before the answer to the command")
    }
}
