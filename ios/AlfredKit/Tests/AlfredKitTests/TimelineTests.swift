import AlfredKit
import Foundation
import XCTest

final class TimelineTests: XCTestCase {
    /// A live message delta of run k7m2qa on the given stream.
    private func delta(_ streamId: String, _ text: String) throws -> StreamEvent {
        let json = #"{"at":"2026-10-25T08:32:02.000Z","type":"message.delta","data":{"runId":"k7m2qa","streamId":"\#(streamId)","text":"\#(text)"}}"#
        return try JSONDecoder().decode(StreamEvent.self, from: Data(json.utf8))
    }

    func testStoredEventsFoldInIDOrder() throws {
        var timeline = Timeline()
        for path in [
            "events/message-created-app-in.json",
            "events/run-updated-running.json",
            "events/message-created-wechat-in-image.json",
            "events/run-updated-subagent.json",
            "events/run-updated-done.json",
            "events/message-created-app-out.json",
            "events/message-created-wechat-out-error.json",
            "events/run-updated-failed.json",
        ] {
            timeline.apply(try streamEvent(path))
        }
        XCTAssertEqual(timeline.messages.map(\.id), ["m1001", "m1002", "m1003", "m1004"])
        XCTAssertEqual(timeline.runs.keys.sorted(), ["d8j3sx", "h6w4tz", "k7m2qa"])
        XCTAssertEqual(timeline.runs["k7m2qa"]?.status, RunStatus.done)
        XCTAssertEqual(timeline.runs["d8j3sx"]?.status, RunStatus.failed)
        XCTAssertEqual(timeline.lastEventId, 8)
    }

    func testAReplayedEventDoesNotAddAMessageTwice() throws {
        var timeline = Timeline()
        timeline.apply(try streamEvent("events/message-created-app-in.json"))
        timeline.apply(try streamEvent("events/message-created-app-in.json"))
        XCTAssertEqual(timeline.messages.map(\.id), ["m1001"])
        XCTAssertEqual(timeline.lastEventId, 1)

        timeline.apply(try streamEvent("events/run-updated-done.json"))
        timeline.apply(try streamEvent("events/run-updated-running.json"))
        XCTAssertEqual(timeline.runs["k7m2qa"]?.status, RunStatus.done, "an older event does not overwrite a newer one")
    }

    func testAMessageCreatedWithTheSameIDAsAKnownMessageIsNotAddedAgain() throws {
        var timeline = Timeline()
        timeline.apply(try streamEvent("events/message-created-app-in.json"))
        let json = #"{"id":11,"at":"2026-10-25T08:30:00Z","type":"message.created","data":{"id":"m1001","channel":"app","direction":"in","text":"帮我查一下 VPS 价格","files":[],"at":"2026-10-25T08:30:00Z","clientId":"c-7f3a9e"}}"#
        timeline.apply(try JSONDecoder().decode(StreamEvent.self, from: Data(json.utf8)))
        XCTAssertEqual(timeline.messages.map(\.id), ["m1001"])
        XCTAssertEqual(timeline.lastEventId, 11)
    }

    func testAPendingOwnerMessageIsReplacedByItsStoredMessage() throws {
        var timeline = Timeline()
        timeline.addPending(clientId: "c-7f3a9e", text: "帮我查一下 VPS 价格")
        XCTAssertEqual(timeline.pending.map(\.clientId), ["c-7f3a9e"])
        XCTAssertEqual(timeline.pending.first?.text, "帮我查一下 VPS 价格")
        XCTAssertEqual(timeline.messages, [])

        timeline.apply(try streamEvent("events/message-created-app-in.json"))
        XCTAssertEqual(timeline.pending, [])
        XCTAssertEqual(timeline.messages.map(\.id), ["m1001"])
    }

    func testAPendingMessageWaitsForItsOwnClientID() throws {
        var timeline = Timeline()
        timeline.addPending(clientId: "c-other", text: "还没发完")
        timeline.apply(try streamEvent("events/message-created-app-in.json"))
        XCTAssertEqual(timeline.pending.map(\.clientId), ["c-other"])
    }

    func testDeltasOfOneStreamConcatenateIntoTheRunsDraft() throws {
        var timeline = Timeline()
        timeline.apply(try streamEvent("live/message-delta.json"))
        timeline.apply(try delta("k7m2qa.2", "价格如下。"))
        XCTAssertEqual(timeline.drafts["k7m2qa"]?.streamId, "k7m2qa.2")
        XCTAssertEqual(timeline.drafts["k7m2qa"]?.text, "我先查一下官网的定价页。价格如下。")
        XCTAssertEqual(timeline.messages, [])
    }

    func testANewStreamReplacesTheDraft() throws {
        var timeline = Timeline()
        timeline.apply(try streamEvent("live/message-delta.json"))
        timeline.apply(try delta("k7m2qa.3", "换一种说法。"))
        XCTAssertEqual(timeline.drafts["k7m2qa"]?.streamId, "k7m2qa.3")
        XCTAssertEqual(timeline.drafts["k7m2qa"]?.text, "换一种说法。")
    }

    func testAnOutboundMessageOfTheRunRemovesItsDraft() throws {
        var timeline = Timeline()
        timeline.apply(try streamEvent("live/message-delta.json"))
        timeline.apply(try streamEvent("events/message-created-app-out.json"))
        XCTAssertNil(timeline.drafts["k7m2qa"])
        XCTAssertEqual(timeline.messages.map(\.id), ["m1003"])
    }

    func testARunEndingRemovesItsDraftAndItsLatestStep() throws {
        var timeline = Timeline()
        timeline.apply(try streamEvent("live/run-step.json"))
        timeline.apply(try streamEvent("live/message-delta.json"))
        XCTAssertNotNil(timeline.drafts["k7m2qa"])
        XCTAssertNotNil(timeline.latestStep["k7m2qa"])

        timeline.apply(try streamEvent("events/run-updated-done.json"))
        XCTAssertNil(timeline.drafts["k7m2qa"])
        XCTAssertNil(timeline.latestStep["k7m2qa"])
        XCTAssertEqual(timeline.runs["k7m2qa"]?.status, RunStatus.done)
    }

    func testLatestStepIsKeptPerRunAndTheNewestWins() throws {
        var timeline = Timeline()
        timeline.apply(try streamEvent("live/run-step.json"))
        timeline.apply(try streamEvent("live/run-step-subagent.json"))
        XCTAssertEqual(timeline.latestStep["k7m2qa"]?.tool, "WebFetch")
        XCTAssertEqual(timeline.latestStep["h6w4tz"]?.tool, "Read")
        XCTAssertEqual(timeline.latestStep["h6w4tz"]?.agent, "reviewer")

        timeline.apply(try delta("k7m2qa.2", "x"))
        timeline.apply(try streamEvent("live/run-step.json"))
        XCTAssertEqual(timeline.latestStep["k7m2qa"]?.detail, "https://example.com/pricing")
    }

    func testUnknownEventsChangeNothing() throws {
        var timeline = Timeline()
        timeline.apply(try streamEvent("events/message-created-app-in.json"))
        timeline.apply(try streamEvent("live/message-delta.json"))
        timeline.addPending(clientId: "c-other", text: "x")
        let before = timeline

        timeline.apply(try streamEvent("future/event-unknown-type.json"))
        timeline.apply(try streamEvent("future/live-event-unknown-type.json"))
        XCTAssertEqual(timeline, before)
    }

    func testAnExtraFieldInAnEventIsIgnored() throws {
        var timeline = Timeline()
        timeline.apply(try streamEvent("future/event-extra-field.json"))
        XCTAssertEqual(timeline.messages.map(\.id), ["m1005"])
        XCTAssertEqual(timeline.messages.first?.runId, "k7m2qa")
    }
}
