import AlfredKit
import Foundation
import XCTest

final class IdeaFixtureTests: XCTestCase {
    private enum FixtureError: Error {
        case notAnIdea(String)
    }

    private func decodeEvent(_ name: String) throws -> Event {
        try JSONDecoder().decode(Event.self, from: Data(contentsOf: Fixtures.directory.appending(path: name)))
    }

    private func decodeCommand(_ name: String) throws -> Command {
        try JSONDecoder().decode(Command.self, from: Data(contentsOf: Fixtures.directory.appending(path: name)))
    }

    private func decodeFixture<T: Decodable>(_ type: T.Type, _ name: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(contentsOf: Fixtures.directory.appending(path: name)))
    }

    /// The idea of an idea.updated fixture.
    private func idea(_ name: String) throws -> AlfredIdea {
        guard case let .ideaUpdated(idea) = try decodeEvent(name).payload else {
            throw FixtureError.notAnIdea(name)
        }
        return idea
    }

    func testOpenOnceIdeaHasNoScheduleOrTask() throws {
        let idea = try idea("events/idea-updated-open-once.json")
        XCTAssertEqual(idea.id, "h3v8ct")
        XCTAssertEqual(idea.title, "对比三家 VPS 的带宽配额")
        XCTAssertEqual(idea.kind, .once)
        XCTAssertNil(idea.schedule)
        XCTAssertEqual(idea.model, .sonnet)
        XCTAssertEqual(idea.estimateUsd, 0.35)
        XCTAssertEqual(idea.state, .open)
        XCTAssertNil(idea.taskId)
        XCTAssertNil(idea.rejection)
        XCTAssertEqual(idea.runId, "v7c2mb")
    }

    func testRecurringIdeaCarriesTheScheduleItProposes() throws {
        let idea = try idea("events/idea-updated-open-recurring.json")
        XCTAssertEqual(idea.kind, .recurring)
        XCTAssertEqual(idea.schedule, .weekly(days: [1], time: TimeOfDay(hour: 9, minute: 0)))
        XCTAssertEqual(idea.state, .open)
    }

    func testAcceptedIdeaNamesItsTask() throws {
        let idea = try idea("events/idea-updated-accepted.json")
        XCTAssertEqual(idea.state, .accepted)
        XCTAssertEqual(idea.taskId, "n2c7bq")
        XCTAssertEqual(idea.schedule, .interval(hours: 6))
        XCTAssertNil(idea.rejection)
    }

    func testRejectedIdeaCarriesItsReasonAndNote() throws {
        let idea = try idea("events/idea-updated-rejected.json")
        XCTAssertEqual(idea.state, .rejected)
        XCTAssertEqual(idea.rejection?.reason, .notInterested)
        XCTAssertEqual(idea.rejection?.note, "我自己会翻。")
        XCTAssertNil(idea.taskId)
    }

    func testArchivedIdeaHasNeitherATaskNorARejection() throws {
        let idea = try idea("events/idea-updated-archived.json")
        XCTAssertEqual(idea.state, .archived)
        XCTAssertNil(idea.taskId)
        XCTAssertNil(idea.rejection)
    }

    func testAGenerationRunIsARunOfItsOwnKind() throws {
        guard case let .runUpdated(run) = try decodeEvent("events/run-updated-ideas.json").payload else {
            return XCTFail("expected a run.updated event")
        }
        XCTAssertEqual(run.kind, .ideas)
        XCTAssertEqual(run.title, "生成想法")
        XCTAssertNil(run.taskId)
    }

    func testIdeaListHasEveryStateAndTheGeneratingRun() throws {
        let list = try decodeFixture(IdeaList.self, "responses/idea-list.json")
        XCTAssertEqual(list.ideas.map(\.id), ["h3v8ct", "d6n2gs", "m7x2zd", "k4p9rx", "t5w6pf"])
        XCTAssertEqual(Set(list.ideas.map(\.state)), [.open, .accepted, .rejected, .archived])
        XCTAssertEqual(list.generatingRunId, "c9t5hq")
    }

    func testEmptyIdeaListHasNoGeneratingRun() throws {
        let list = try decodeFixture(IdeaList.self, "responses/idea-list-empty.json")
        XCTAssertEqual(list.ideas, [])
        XCTAssertNil(list.generatingRunId)
    }

    func testIdeaListsWithoutALastGenerationHaveNone() throws {
        XCTAssertNil(try decodeFixture(IdeaList.self, "responses/idea-list.json").lastGeneration)
        XCTAssertNil(try decodeFixture(IdeaList.self, "responses/idea-list-empty.json").lastGeneration)
    }

    func testAListThatFoundNothingNewCarriesTheLastGenerationWithItsNote() throws {
        let list = try decodeFixture(IdeaList.self, "responses/idea-list-nothing-new.json")
        XCTAssertEqual(list.ideas, [])
        XCTAssertNil(list.generatingRunId)
        let generation = try XCTUnwrap(list.lastGeneration)
        XCTAssertEqual(generation.runId, "w4k8ns")
        XCTAssertEqual(generation.endedAt, Date(timeIntervalSince1970: 1_793_150_132))
        XCTAssertEqual(generation.status, .done)
        XCTAssertEqual(generation.trigger, .requested)
        XCTAssertEqual(generation.added, 0)
        XCTAssertEqual(generation.note, "最近的对话多是在测试功能，暂时没有值得提的。")
    }

    func testAFailedGenerationHasNoNoteAndSitsBesideTheOpenIdeas() throws {
        let list = try decodeFixture(IdeaList.self, "responses/idea-list-failed.json")
        XCTAssertEqual(list.ideas.map(\.id), ["h3v8ct"])
        let generation = try XCTUnwrap(list.lastGeneration)
        XCTAssertEqual(generation.runId, "x6p3dc")
        XCTAssertEqual(generation.status, .failed)
        XCTAssertEqual(generation.trigger, .daily)
        XCTAssertEqual(generation.added, 0)
        XCTAssertNil(generation.note)
    }

    func testAnUnknownGenerationStatusAndTriggerDecodeAsThemselves() throws {
        let json = """
        {"ideas":[],"lastGeneration":{"runId":"w4k8ns","endedAt":"2026-10-28T01:15:32.000Z","status":"cancelled","trigger":"weekly","added":2}}
        """
        let generation = try XCTUnwrap(try JSONDecoder().decode(IdeaList.self, from: Data(json.utf8)).lastGeneration)
        XCTAssertEqual(generation.status.rawValue, "cancelled")
        XCTAssertEqual(generation.trigger.rawValue, "weekly")
        XCTAssertEqual(generation.added, 2)
    }

    func testIdeaAcceptedIsTheIdeaAndTheTaskItMade() throws {
        let accepted = try decodeFixture(IdeaAccepted.self, "responses/idea-accepted.json")
        XCTAssertEqual(accepted.idea.state, .accepted)
        XCTAssertEqual(accepted.idea.taskId, accepted.task.id)
        XCTAssertEqual(accepted.task.origin, .idea)
    }

    func testIdeaResultAndGenerationAcceptedDecode() throws {
        let result = try decodeFixture(IdeaResult.self, "responses/idea-result.json")
        XCTAssertEqual(result.idea.rejection?.reason, .notInterested)
        let generation = try decodeFixture(IdeaGenerationAccepted.self, "responses/idea-generation-accepted.json")
        XCTAssertEqual(generation.runId, "c9t5hq")
    }

    func testAcceptCommandsCarryTheTaskTheOwnerConfirmed() throws {
        XCTAssertEqual(
            try decodeCommand("commands/idea-accept-once.json"),
            .ideaAccept(
                ideaId: "h3v8ct",
                title: "对比三家 VPS 的带宽配额",
                brief: "查 Hetzner、Vultr 和 DigitalOcean 官网的带宽与流量政策，整理成一张表，附上来源链接。",
                schedule: nil,
                model: .sonnet,
                budgetUsd: 1
            )
        )
        XCTAssertEqual(
            try decodeCommand("commands/idea-accept-recurring.json"),
            .ideaAccept(
                ideaId: "d6n2gs",
                title: "每日追踪 VPS 价格变化",
                brief: "每天 09:00 看一次 Hetzner、Vultr 和 DigitalOcean 的定价页，只报告和昨天相比的变化。",
                schedule: .daily(time: TimeOfDay(hour: 9, minute: 0)),
                model: .sonnet,
                budgetUsd: 0.5
            )
        )
    }

    func testRejectAndGenerateCommands() throws {
        XCTAssertEqual(
            try decodeCommand("commands/idea-reject.json"),
            .ideaReject(ideaId: "m7x2zd", reason: .notInterested, note: "我自己会翻。")
        )
        XCTAssertEqual(try decodeCommand("commands/idea-reject-no-note.json"), .ideaReject(ideaId: "h3v8ct", reason: .notNow, note: nil))
        XCTAssertEqual(try decodeCommand("commands/idea-generate.json"), .ideaGenerate)
    }

    func testAnAbsentScheduleAndNoteAreLeftOutWhenEncoded() throws {
        let accept = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(Command.ideaAccept(
            ideaId: "h3v8ct",
            title: "对比三家 VPS 的带宽配额",
            brief: "查带宽。",
            schedule: nil,
            model: .sonnet,
            budgetUsd: 1
        ))) as? [String: Any])
        XCTAssertNil(accept["schedule"])
        XCTAssertEqual(accept["type"] as? String, "idea.accept")

        let reject = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(Command.ideaReject(
            ideaId: "h3v8ct",
            reason: .notNow,
            note: nil
        ))) as? [String: Any])
        XCTAssertNil(reject["note"])
        XCTAssertEqual(reject["reason"] as? String, "not-now")
    }

    func testAnUnknownIdeaStateAndRejectionReasonDecodeAsThemselves() throws {
        let json = """
        {"id":14,"at":"2026-10-27T01:12:04Z","type":"idea.updated","data":{"id":"h3v8ct","title":"对比价格","why":"你问过。","brief":"查价格。","kind":"once","model":"sonnet","estimateUsd":0.3,"state":"snoozed","rejection":{"reason":"too-busy"},"runId":"v7c2mb","createdAt":"2026-10-27T01:12:04Z","updatedAt":"2026-10-27T01:12:04Z"}}
        """
        let event = try JSONDecoder().decode(Event.self, from: Data(json.utf8))
        guard case let .ideaUpdated(idea) = event.payload else {
            return XCTFail("expected an idea.updated event, got \(event.payload)")
        }
        XCTAssertEqual(idea.state.rawValue, "snoozed")
        XCTAssertEqual(idea.rejection?.reason.rawValue, "too-busy")
    }
}
