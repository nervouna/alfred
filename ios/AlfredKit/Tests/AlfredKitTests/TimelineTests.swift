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

    func testAQuestionIsOpenFromItsEventUntilItIsAnswered() throws {
        var timeline = Timeline()
        XCTAssertEqual(timeline.openQuestions, [:])

        timeline.apply(try streamEvent("events/question-asked.json"))
        XCTAssertEqual(timeline.openQuestions.keys.sorted(), ["q-8f2a41c0"])
        XCTAssertEqual(timeline.openQuestions["q-8f2a41c0"]?.runId, "k7m2qa")
        XCTAssertEqual(timeline.openQuestions["q-8f2a41c0"]?.questions.count, 2)
        XCTAssertEqual(timeline.lastEventId, 9)

        timeline.apply(try streamEvent("events/question-answered.json"))
        XCTAssertEqual(timeline.openQuestions, [:])
        XCTAssertEqual(timeline.lastEventId, 10)
    }

    func testACancelledQuestionIsNoLongerOpen() throws {
        var timeline = Timeline()
        timeline.apply(try streamEvent("events/question-asked.json"))
        timeline.apply(try streamEvent("events/question-answered-cancelled.json"))
        XCTAssertEqual(timeline.openQuestions, [:])
    }

    func testOpenQuestionsAreKeptById() throws {
        var timeline = Timeline()
        timeline.apply(try streamEvent("events/question-asked.json"))
        let second = #"{"id":10,"at":"2026-10-25T08:38:00Z","type":"question.asked","data":{"id":"q-second","runId":"k7m2qa","questions":[{"question":"继续吗？","header":"确认","options":[{"label":"继续","description":"接着做"},{"label":"停","description":"到此为止"}],"multiSelect":false}]}}"#
        timeline.apply(try JSONDecoder().decode(StreamEvent.self, from: Data(second.utf8)))
        XCTAssertEqual(timeline.openQuestions.keys.sorted(), ["q-8f2a41c0", "q-second"])

        let answer = #"{"id":11,"at":"2026-10-25T08:38:30Z","type":"question.answered","data":{"id":"q-8f2a41c0","runId":"k7m2qa","answers":{"报告用哪种格式？":"短表格"}}}"#
        timeline.apply(try JSONDecoder().decode(StreamEvent.self, from: Data(answer.utf8)))
        XCTAssertEqual(timeline.openQuestions.keys.sorted(), ["q-second"], "answering one leaves the other open")
    }

    func testAReplayedQuestionEventChangesNothing() throws {
        var timeline = Timeline()
        timeline.apply(try streamEvent("events/question-asked.json"))
        timeline.apply(try streamEvent("events/question-answered.json"))
        timeline.apply(try streamEvent("events/question-asked.json"))
        XCTAssertEqual(timeline.openQuestions, [:], "an id already applied is not applied again")
        XCTAssertEqual(timeline.lastEventId, 10)
    }

    func testAnAnswerForAQuestionNeverSeenChangesNothing() throws {
        var timeline = Timeline()
        timeline.apply(try streamEvent("events/question-answered.json"))
        XCTAssertEqual(timeline.openQuestions, [:])
        XCTAssertEqual(timeline.lastEventId, 10)
    }

    // MARK: Questions in the timeline

    private func decodeStream(_ json: String) throws -> StreamEvent {
        try JSONDecoder().decode(StreamEvent.self, from: Data(json.utf8))
    }

    /// A stored `run.updated` event of a task.
    private func runUpdated(_ id: Int, runId: String = "k7m2qa", status: String) throws -> StreamEvent {
        try decodeStream(#"{"id":\#(id),"at":"2026-10-25T08:40:00Z","type":"run.updated","data":{"id":"\#(runId)","kind":"task","title":"调研","status":"\#(status)","startedAt":"2026-10-25T08:30:05Z","costUsd":0,"files":[]}}"#)
    }

    /// A stored `question.asked` event with one single-select question.
    private func questionAsked(_ id: Int, questionId: String, runId: String = "k7m2qa") throws -> StreamEvent {
        try decodeStream(#"{"id":\#(id),"at":"2026-10-25T08:36:00Z","type":"question.asked","data":{"id":"\#(questionId)","runId":"\#(runId)","questions":[{"question":"继续吗？","header":"确认","options":[{"label":"继续","description":"接着做"},{"label":"停","description":"到此为止"}],"multiSelect":false}]}}"#)
    }

    /// A stored `question.answered` event.
    private func questionAnswered(_ id: Int, questionId: String, answers: String = #"{"继续吗？":"继续"}"#, cancelled: Bool = false) throws -> StreamEvent {
        try decodeStream(#"{"id":\#(id),"at":"2026-10-25T08:37:00Z","type":"question.answered","data":{"id":"\#(questionId)","runId":"k7m2qa","answers":\#(answers)\#(cancelled ? #","cancelled":true"# : "")}}"#)
    }

    /// A stored outbound `message.created` event.
    private func reply(_ id: Int, messageId: String) throws -> StreamEvent {
        try decodeStream(#"{"id":\#(id),"at":"2026-10-25T08:38:00Z","type":"message.created","data":{"id":"\#(messageId)","channel":"app","direction":"out","text":"好的","files":[],"at":"2026-10-25T08:38:00Z"}}"#)
    }

    func testAQuestionKeepsItsStateFromOpenToAnswered() throws {
        var timeline = Timeline()
        timeline.apply(try streamEvent("events/question-asked.json"))
        XCTAssertEqual(timeline.questions.map(\.id), ["q-8f2a41c0"])
        XCTAssertEqual(timeline.questions.first?.state, .open)
        XCTAssertEqual(timeline.questions.first?.asked.questions.count, 2)

        timeline.apply(try streamEvent("events/question-answered.json"))
        XCTAssertEqual(timeline.questions.count, 1, "an answered question stays")
        XCTAssertEqual(
            timeline.questions.first?.state,
            .answered(["报告用哪种格式？": "短表格", "要对比哪些供应商？": "Hetzner, Vultr"])
        )
        XCTAssertEqual(timeline.openQuestions, [:])
    }

    func testACancelledQuestionStaysAsCancelled() throws {
        var timeline = Timeline()
        timeline.apply(try streamEvent("events/question-asked.json"))
        timeline.apply(try streamEvent("events/question-answered-cancelled.json"))
        XCTAssertEqual(timeline.questions.first?.state, .cancelled)
        XCTAssertEqual(timeline.openQuestions, [:])
    }

    func testQuestionsKeepEventOrderAmongTheMessages() throws {
        var timeline = Timeline()
        timeline.apply(try streamEvent("events/message-created-app-in.json"))
        timeline.apply(try questionAsked(2, questionId: "q-first"))
        timeline.apply(try questionAsked(3, questionId: "q-second"))
        timeline.apply(try questionAnswered(4, questionId: "q-first"))
        timeline.apply(try reply(5, messageId: "m2001"))
        timeline.apply(try questionAsked(6, questionId: "q-third"))

        XCTAssertEqual(timeline.questions.map(\.id), ["q-first", "q-second", "q-third"])
        XCTAssertEqual(timeline.questions.map(\.afterMessages), [1, 1, 2])
        XCTAssertEqual(
            timeline.items.map(\.id),
            ["m-m1001", "q-q-first", "q-q-second", "m-m2001", "q-q-third"]
        )
    }

    func testAQuestionAskedBeforeAnyMessageComesFirst() throws {
        var timeline = Timeline()
        timeline.apply(try questionAsked(1, questionId: "q-first"))
        timeline.apply(try reply(2, messageId: "m2001"))
        XCTAssertEqual(timeline.items.map(\.id), ["q-q-first", "m-m2001"])
    }

    func testAQuestionStaysWhereItWasAskedWhenItsStateChanges() throws {
        var timeline = Timeline()
        timeline.apply(try streamEvent("events/message-created-app-in.json"))
        timeline.apply(try questionAsked(2, questionId: "q-first"))
        timeline.apply(try reply(3, messageId: "m2001"))
        let before = timeline.items.map(\.id)

        timeline.apply(try questionAnswered(4, questionId: "q-first"))
        timeline.apply(try runUpdated(5, status: "done"))
        XCTAssertEqual(timeline.items.map(\.id), before)
    }

    func testARunEndingEndsItsOpenQuestions() throws {
        for status in ["done", "stopped", "failed", "lost"] {
            var timeline = Timeline()
            timeline.apply(try questionAsked(1, questionId: "q-mine"))
            timeline.apply(try runUpdated(2, status: status))
            XCTAssertEqual(timeline.questions.first?.state, .ended, status)
            XCTAssertEqual(timeline.openQuestions, [:], status)
        }
    }

    func testARunThatKeepsRunningLeavesItsQuestionsOpen() throws {
        var timeline = Timeline()
        timeline.apply(try questionAsked(1, questionId: "q-mine"))
        timeline.apply(try runUpdated(2, status: "running"))
        timeline.apply(try runUpdated(3, status: "queued"))
        XCTAssertEqual(timeline.questions.first?.state, .open)
        XCTAssertEqual(timeline.openQuestions.keys.sorted(), ["q-mine"])
    }

    func testARunEndingLeavesOtherRunsAndAnsweredQuestionsAlone() throws {
        var timeline = Timeline()
        timeline.apply(try questionAsked(1, questionId: "q-answered"))
        timeline.apply(try questionAnswered(2, questionId: "q-answered"))
        timeline.apply(try questionAsked(3, questionId: "q-cancelled"))
        timeline.apply(try questionAnswered(4, questionId: "q-cancelled", answers: "{}", cancelled: true))
        timeline.apply(try questionAsked(5, questionId: "q-other", runId: "h6w4tz"))
        timeline.apply(try questionAsked(6, questionId: "q-open"))

        timeline.apply(try runUpdated(7, status: "lost"))

        let states = Dictionary(uniqueKeysWithValues: timeline.questions.map { ($0.id, $0.state) })
        XCTAssertEqual(states["q-answered"], .answered(["继续吗？": "继续"]))
        XCTAssertEqual(states["q-cancelled"], .cancelled)
        XCTAssertEqual(states["q-other"], .open, "another run's question")
        XCTAssertEqual(states["q-open"], .ended)
        XCTAssertEqual(timeline.openQuestions.keys.sorted(), ["q-other"])
    }

    func testAnAnswerThatArrivesAfterTheRunEndedIsStillShown() throws {
        var timeline = Timeline()
        timeline.apply(try questionAsked(1, questionId: "q-mine"))
        timeline.apply(try runUpdated(2, status: "stopped"))
        timeline.apply(try questionAnswered(3, questionId: "q-mine"))
        XCTAssertEqual(timeline.questions.first?.state, .answered(["继续吗？": "继续"]))
    }

    func testAReplayedRunUpdateDoesNotEndAQuestionAskedLater() throws {
        var timeline = Timeline()
        timeline.apply(try runUpdated(5, status: "done"))
        timeline.apply(try questionAsked(6, questionId: "q-later"))
        timeline.apply(try runUpdated(5, status: "done"))
        XCTAssertEqual(timeline.questions.first?.state, .open, "an event already applied changes nothing")
    }

    func testAQuestionWithAKnownIDIsKeptOnce() throws {
        var timeline = Timeline()
        timeline.apply(try questionAsked(1, questionId: "q-mine"))
        timeline.apply(try reply(2, messageId: "m2001"))
        timeline.apply(try questionAsked(3, questionId: "q-mine"))
        XCTAssertEqual(timeline.questions.map(\.afterMessages), [0])
        XCTAssertEqual(timeline.lastEventId, 3)
    }

    func testUnknownEventsChangeNothingButTheResumePoint() throws {
        var timeline = Timeline()
        timeline.apply(try streamEvent("events/message-created-app-in.json"))
        timeline.apply(try streamEvent("live/message-delta.json"))
        timeline.addPending(clientId: "c-other", text: "x")
        let before = timeline

        timeline.apply(try streamEvent("future/event-unknown-type.json"))
        timeline.apply(try streamEvent("future/live-event-unknown-type.json"))
        XCTAssertEqual(timeline.lastEventId, 9)
        XCTAssertEqual(timeline.messages, before.messages)
        XCTAssertEqual(timeline.pending, before.pending)
        XCTAssertEqual(timeline.drafts, before.drafts)
        XCTAssertEqual(timeline.runs, before.runs)
        XCTAssertEqual(timeline.latestStep, before.latestStep)
    }

    func testAnExtraFieldInAnEventIsIgnored() throws {
        var timeline = Timeline()
        timeline.apply(try streamEvent("future/event-extra-field.json"))
        XCTAssertEqual(timeline.messages.map(\.id), ["m1005"])
        XCTAssertEqual(timeline.messages.first?.runId, "k7m2qa")
    }
}
