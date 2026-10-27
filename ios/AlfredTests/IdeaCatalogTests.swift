import AlfredKit
import XCTest

@testable import Alfred

final class IdeaCatalogTests: XCTestCase {
    private func catalog(_ ideas: [[String: Any]], generatingRunId: String? = nil, lastGeneration: [String: Any]? = nil) throws -> IdeaCatalog {
        var catalog = IdeaCatalog()
        catalog.load(try TestData.decodedIdeaList(ideas, generatingRunId: generatingRunId, lastGeneration: lastGeneration))
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

    // MARK: The last generation

    func testNoGenerationHasEndedUntilAListSaysSo() throws {
        XCTAssertNil(IdeaCatalog().lastGeneration)
        XCTAssertNil(try catalog([TestData.ideaObject("aaaaaa")]).lastGeneration)
        XCTAssertNil(IdeaCatalog().generationLine)
    }

    func testAListKeepsItsLastGenerationAndTheLineIsItsNote() throws {
        let loaded = try catalog([], lastGeneration: TestData.generationObject("w4k8ns", note: "最近的对话多是在测试功能，暂时没有值得提的。"))
        XCTAssertEqual(loaded.lastGeneration?.runId, "w4k8ns")
        XCTAssertEqual(loaded.lastGeneration?.added, 0)
        XCTAssertEqual(loaded.generationLine, "最近的对话多是在测试功能，暂时没有值得提的。")
    }

    func testTheLineHasThePresentationsThreeTexts() throws {
        XCTAssertEqual(try catalog([], lastGeneration: TestData.generationObject(note: "今天没有。")).generationLine, "今天没有。")
        XCTAssertEqual(try catalog([], lastGeneration: TestData.generationObject(note: nil)).generationLine, "这次没有新想法")
        XCTAssertEqual(try catalog([], lastGeneration: TestData.generationObject(status: "failed", note: nil)).generationLine, "这次没想成，可以再试一次")
    }

    func testThereIsNoLineWhenTheLastGenerationAddedIdeas() throws {
        let loaded = try catalog([TestData.ideaObject("aaaaaa")], lastGeneration: TestData.generationObject(added: 2, note: "想到两个。"))
        XCTAssertEqual(loaded.lastGeneration?.added, 2)
        XCTAssertNil(loaded.generationLine)
    }

    func testANewerLastGenerationReplacesTheOneBeforeAndAnOlderOrMissingOneDoesNot() throws {
        var catalog = try catalog([], lastGeneration: TestData.generationObject("aaaaa2", note: "第一次。", endedAt: "2026-10-28T01:00:00.000Z"))
        catalog.load(try TestData.decodedIdeaList([], lastGeneration: TestData.generationObject("bbbbb2", note: "第二次。", endedAt: "2026-10-28T02:00:00.000Z")))
        XCTAssertEqual(catalog.generationLine, "第二次。")

        catalog.load(try TestData.decodedIdeaList([], lastGeneration: TestData.generationObject("aaaaa2", note: "第一次。", endedAt: "2026-10-28T01:00:00.000Z")))
        XCTAssertEqual(catalog.generationLine, "第二次。", "a list read before the second generation ended cannot undo it")
        catalog.load(try TestData.decodedIdeaList([]))
        XCTAssertEqual(catalog.generationLine, "第二次。", "nor can one that has no generation")
    }

    // MARK: The line while a generation runs

    func testTheLineGoesWhenAGenerationStartsOrIsAcceptedAndWhenTheListSaysOneIsRunning() throws {
        let last = TestData.generationObject(note: "暂时没有值得提的。")

        var accepted = try catalog([], lastGeneration: last)
        XCTAssertEqual(accepted.generationLine, "暂时没有值得提的。")
        accepted.noteGeneration(runId: "c9t5hq")
        XCTAssertNil(accepted.generationLine, "the command was accepted")

        var running = try catalog([], lastGeneration: last)
        running.apply(try TestData.generationEvent(1, run: "c9t5hq", status: "running"))
        XCTAssertNil(running.generationLine, "its run is running")

        XCTAssertNil(try catalog([], generatingRunId: "c9t5hq", lastGeneration: last).generationLine, "the list says one is running")
    }

    func testTheLineStaysAwayWhenTheRunEndsUntilAListTellsHowItEnded() throws {
        var catalog = try catalog([], lastGeneration: TestData.generationObject("aaaaa2", note: "上一次没有。", endedAt: "2026-10-28T01:00:00.000Z"))
        catalog.apply(try TestData.generationEvent(1, run: "c9t5hq", status: "running"))
        catalog.apply(try TestData.generationEvent(2, run: "c9t5hq", status: "done"))
        XCTAssertFalse(catalog.isGenerating)
        XCTAssertNil(catalog.generationLine, "the line before would be about the generation before")

        catalog.load(try TestData.decodedIdeaList([TestData.ideaObject("bbbbbb")], lastGeneration: TestData.generationObject("c9t5hq", added: 1, note: "想到一个。", endedAt: "2026-10-28T02:00:00.000Z")))
        XCTAssertNil(catalog.generationLine, "the generation added an idea, so there is no line")
    }

    func testTheLineReturnsWithTheNoteOfTheGenerationThatEndedWhenItAddedNone() throws {
        var catalog = try catalog([], lastGeneration: TestData.generationObject("aaaaa2", note: "上一次没有。", endedAt: "2026-10-28T01:00:00.000Z"))
        catalog.apply(try TestData.generationEvent(1, run: "c9t5hq", status: "running"))
        catalog.apply(try TestData.generationEvent(2, run: "c9t5hq", status: "done"))
        catalog.load(try TestData.decodedIdeaList([], lastGeneration: TestData.generationObject("c9t5hq", note: "这次也没有。", endedAt: "2026-10-28T02:00:00.000Z")))
        XCTAssertEqual(catalog.generationLine, "这次也没有。")
    }

    func testAFailedRunShowsItsLineOnceTheListHasBeenRead() throws {
        var catalog = try catalog([], lastGeneration: TestData.generationObject("aaaaa2", note: "上一次没有。", endedAt: "2026-10-28T01:00:00.000Z"))
        catalog.apply(try TestData.generationEvent(1, run: "c9t5hq", status: "running"))
        catalog.apply(try TestData.generationEvent(2, run: "c9t5hq", status: "failed"))
        XCTAssertNil(catalog.generationLine)
        catalog.load(try TestData.decodedIdeaList([], lastGeneration: TestData.generationObject("c9t5hq", status: "failed", note: nil, endedAt: "2026-10-28T02:00:00.000Z")))
        XCTAssertEqual(catalog.generationLine, "这次没想成，可以再试一次")
    }

    // MARK: Which events end a generation

    func testARunOfKindIdeasThatLeavesQueuedAndRunningEndsAGeneration() throws {
        for status in ["done", "failed", "stopped", "lost", "paused"] {
            XCTAssertTrue(IdeaCatalog.endsGeneration(try TestData.generationEvent(1, run: "c9t5hq", status: status)), status)
        }
        for status in ["queued", "running"] {
            XCTAssertFalse(IdeaCatalog.endsGeneration(try TestData.generationEvent(1, run: "c9t5hq", status: status)), status)
        }
    }

    func testOtherRunsAndOtherEventsEndNoGeneration() throws {
        let task = try TestData.streamEvent(TestData.runEvent(1, run: TestData.runObject("r1", status: "done"), at: "2026-10-27T01:00:00.000Z"))
        XCTAssertFalse(IdeaCatalog.endsGeneration(task), "a run of another kind")
        XCTAssertFalse(IdeaCatalog.endsGeneration(try event(2, TestData.ideaObject("aaaaaa"))), "an idea")
    }
}
