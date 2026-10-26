import AlfredKit
import XCTest

@testable import Alfred

/// How annotations read: the sections of the 批注 list, the highlights, the count, the banner while Alfred revises, and the
/// undo offer.
final class AnnotationPresentationTests: XCTestCase {
    private typealias Presentation = AnnotationPresentation

    private let v1 = TestData.commit(1)
    private let v2 = TestData.commit(2)
    private let v3 = TestData.commit(3)

    private func draft(_ id: String, _ target: AnnotationTarget = .document, comment: String = "草稿话") -> StoredDraft {
        StoredDraft(id: id, documentId: "aaaaaa", version: v1, target: target, comment: comment)
    }

    private func passage(_ quote: String) -> AnnotationTarget {
        .passage(quote: quote, prefix: "", suffix: "")
    }

    /// The ids of a section's rows, or nil when the list has no such section.
    private func ids(_ kind: Presentation.SectionKind, in sections: [Presentation.Section]) -> [String]? {
        sections.first { $0.kind == kind }?.rows.map(\.id)
    }

    // MARK: The sections

    func testEveryStateHasItsSectionInOrder() throws {
        let sections = Presentation.sections(
            drafts: [draft("d1")],
            annotations: [
                try TestData.annotation("sub1", state: "submitted"),
                try TestData.annotation("res1", state: "resolved", reply: "已改"),
                try TestData.annotation("ret1", state: "returned", returnReason: "unanswered"),
            ],
            fits: { _ in true }
        )

        XCTAssertEqual(sections.map(\.title), ["草稿", "修订中", "已回复", "已退回"])
        XCTAssertEqual(sections.map(\.kind), [.drafts, .submitted, .resolved, .returned])
        XCTAssertEqual(ids(.drafts, in: sections), ["d1"])
        XCTAssertEqual(ids(.submitted, in: sections), ["sub1"])
        XCTAssertEqual(ids(.resolved, in: sections), ["res1"])
        XCTAssertEqual(ids(.returned, in: sections), ["ret1"])
    }

    func testASectionWithNoRowsIsLeftOut() throws {
        XCTAssertEqual(Presentation.sections(drafts: [], annotations: [], fits: { _ in true }), [])
        let sections = Presentation.sections(drafts: [], annotations: [try TestData.annotation("res1", state: "resolved", reply: "好")], fits: { _ in true })
        XCTAssertEqual(sections.map(\.title), ["已回复"])
    }

    func testAnAnsweredAnnotationShowsItsReply() throws {
        let sections = Presentation.sections(
            drafts: [],
            annotations: [try TestData.annotation("res1", target: TestData.passageTarget("进口量"), state: "resolved", reply: "已改成具体数字")],
            fits: { _ in true }
        )

        let row = try XCTUnwrap(sections.first?.rows.first)
        XCTAssertEqual(row.reply, "已改成具体数字")
        XCTAssertEqual(row.quote, "进口量")
        XCTAssertEqual(row.comment, "请核对数字")
        XCTAssertNil(row.returnReason)
    }

    func testEachReturnReasonHasItsWords() throws {
        let reasons = [("unanswered", "未回复"), ("undone", "已撤销"), ("stopped", "已停止"), ("failed", "失败")]
        let annotations = try reasons.enumerated().map { index, reason in
            try TestData.annotation("ret\(index)", state: "returned", returnReason: reason.0, createdAt: "2026-10-27T01:00:0\(index).000Z")
        }

        let sections = Presentation.sections(drafts: [], annotations: annotations, fits: { _ in true })

        let returned = try XCTUnwrap(sections.first { $0.kind == .returned })
        let byId = Dictionary(uniqueKeysWithValues: returned.rows.map { ($0.id, $0.returnReason) })
        for (index, reason) in reasons.enumerated() {
            XCTAssertEqual(byId["ret\(index)"] ?? nil, reason.1, reason.0)
        }
    }

    func testAReasonTheAppDoesNotKnowShowsAsTheServerWroteIt() throws {
        let sections = Presentation.sections(
            drafts: [],
            annotations: [try TestData.annotation("ret1", state: "returned", returnReason: "超时")],
            fits: { _ in true }
        )

        XCTAssertEqual(sections.first?.rows.first?.returnReason, "超时")
    }

    func testAReturnedAnnotationKeepsTheReplyItHadBeforeAnUndo() throws {
        let sections = Presentation.sections(
            drafts: [],
            annotations: [try TestData.annotation("ret1", state: "returned", reply: "改好了", returnReason: "undone")],
            fits: { _ in true }
        )

        XCTAssertEqual(sections.first?.rows.first?.reply, "改好了")
        XCTAssertEqual(sections.first?.rows.first?.returnReason, "已撤销")
    }

    func testDraftsAndSubmittedPassagesThatDoNotFitAreListedApart() throws {
        let fits: (AnnotationTarget) -> Bool = { target in
            if case let .passage(quote, _, _) = target { quote == "还在" } else { true }
        }
        let sections = Presentation.sections(
            drafts: [draft("here", passage("还在")), draft("gone", passage("没了")), draft("whole")],
            annotations: [
                try TestData.annotation("subHere", target: TestData.passageTarget("还在"), state: "submitted"),
                try TestData.annotation("subGone", target: TestData.passageTarget("没了"), state: "submitted"),
            ],
            fits: fits
        )

        XCTAssertEqual(ids(.drafts, in: sections), ["here", "whole"])
        XCTAssertEqual(ids(.submitted, in: sections), ["subHere"])
        XCTAssertEqual(ids(.misfit, in: sections), ["gone", "subGone"], "the drafts first")
        XCTAssertEqual(sections.last?.title, "已失配")
        XCTAssertEqual(sections.last?.rows.first?.quote, "没了", "a mismatched passage still shows its quote")
    }

    func testAnswerAndReturnedAnnotationsAreListedWhetherOrNotTheyFit() throws {
        let sections = Presentation.sections(
            drafts: [],
            annotations: [
                try TestData.annotation("res1", target: TestData.passageTarget("没了"), state: "resolved", reply: "好"),
                try TestData.annotation("ret1", target: TestData.passageTarget("没了"), state: "returned", returnReason: "failed"),
            ],
            fits: { _ in false }
        )

        XCTAssertEqual(sections.map(\.kind), [.resolved, .returned])
    }

    func testDraftsAreInTheOrderTheyWereWrittenAndAnswersNewestFirst() throws {
        let sections = Presentation.sections(
            drafts: [draft("d2"), draft("d1")],
            annotations: [
                try TestData.annotation("old", state: "resolved", reply: "好", createdAt: "2026-10-27T01:00:00.000Z"),
                try TestData.annotation("new", state: "resolved", reply: "好", createdAt: "2026-10-27T03:00:00.000Z"),
                try TestData.annotation("sub2", state: "submitted", createdAt: "2026-10-27T02:00:00.000Z"),
                try TestData.annotation("sub1", state: "submitted", createdAt: "2026-10-27T01:00:00.000Z"),
            ],
            fits: { _ in true }
        )

        XCTAssertEqual(ids(.drafts, in: sections), ["d2", "d1"])
        XCTAssertEqual(ids(.submitted, in: sections), ["sub1", "sub2"])
        XCTAssertEqual(ids(.resolved, in: sections), ["new", "old"])
    }

    func testARowKnowsWhatItIs() throws {
        let sections = Presentation.sections(
            drafts: [draft("d1", passage("进口量"), comment: "写具体")],
            annotations: [try TestData.annotation("sub1")],
            fits: { _ in true }
        )

        let draftRow = try XCTUnwrap(sections.first { $0.kind == .drafts }?.rows.first)
        XCTAssertTrue(draftRow.isDraft)
        XCTAssertEqual(draftRow.quote, "进口量")
        XCTAssertEqual(draftRow.comment, "写具体")
        XCTAssertNil(draftRow.reply)
        let annotationRow = try XCTUnwrap(sections.first { $0.kind == .submitted }?.rows.first)
        XCTAssertFalse(annotationRow.isDraft)
        XCTAssertNil(annotationRow.quote, "a comment on the whole document quotes nothing")
    }

    // MARK: The count and the highlights

    func testTheCountIsTheDraftsAndTheAnnotationsStillWithAlfred() throws {
        let annotations = [
            try TestData.annotation("sub1", state: "submitted"),
            try TestData.annotation("res1", state: "resolved", reply: "好"),
            try TestData.annotation("ret1", state: "returned", returnReason: "stopped"),
        ]

        XCTAssertEqual(Presentation.openCount(drafts: [draft("d1"), draft("d2")], annotations: annotations), 3)
        XCTAssertEqual(Presentation.openCount(drafts: [], annotations: []), 0)
    }

    func testTheNewerVersionOfAnAnnotationWins() throws {
        let submitted = try TestData.annotation("a1", state: "submitted", updatedAt: "2026-10-27T01:00:00.000Z")
        let resolved = try TestData.annotation("a1", state: "resolved", reply: "好", updatedAt: "2026-10-27T02:00:00.000Z")

        XCTAssertEqual(Presentation.merged(loaded: [resolved], streamed: [submitted]).map(\.state), [.resolved], "a late event does not undo what the request saw")
        XCTAssertEqual(Presentation.merged(loaded: [submitted], streamed: [resolved]).map(\.state), [.resolved])
        XCTAssertEqual(Presentation.merged(loaded: [submitted], streamed: []).count, 1)
    }

    func testHighlightsAreTheDraftsAndSubmittedPassagesThatFit() throws {
        let piece = AnchorText.Piece(block: 2)
        let placements: [AnnotationTarget: AnchorText.Placement] = [
            passage("甲"): .init(piece: piece, range: NSRange(location: 8, length: 1)),
            passage("乙"): .init(piece: piece, range: NSRange(location: 2, length: 1)),
            passage("丙"): .init(piece: .init(block: 5), range: NSRange(location: 0, length: 3)),
        ]

        let highlights = Presentation.highlights(
            drafts: [draft("d1", passage("甲")), draft("whole"), draft("gone", passage("没了"))],
            annotations: [
                try TestData.annotation("sub1", target: TestData.passageTarget("乙"), state: "submitted"),
                try TestData.annotation("sub2", target: TestData.passageTarget("丙"), state: "submitted"),
                try TestData.annotation("res1", target: TestData.passageTarget("甲"), state: "resolved", reply: "好"),
            ],
            placement: { placements[$0] }
        )

        XCTAssertEqual(highlights[piece], [
            PassageHighlight(id: "sub1", kind: .submitted, range: NSRange(location: 2, length: 1)),
            PassageHighlight(id: "d1", kind: .draft, range: NSRange(location: 8, length: 1)),
        ], "by position in the piece; resolved and mismatched ones are not painted")
        XCTAssertEqual(highlights[.init(block: 5)], [PassageHighlight(id: "sub2", kind: .submitted, range: NSRange(location: 0, length: 3))])
        XCTAssertEqual(highlights.count, 2)
    }

    func testHighlightsAreLabelledForVoiceOver() {
        XCTAssertEqual(PassageHighlight(id: "d1", kind: .draft, range: NSRange(location: 0, length: 1)).label, "草稿")
        XCTAssertEqual(PassageHighlight(id: "s1", kind: .submitted, range: NSRange(location: 0, length: 1)).label, "修订中")
    }

    func testTheSubmitButtonSaysHowManyWillGo() {
        XCTAssertEqual(Presentation.submitTitle(count: 3), "提交 3 条批注")
    }

    // MARK: The banner

    func testTheBannerSaysQueuedOrRevisingAndNamesTheRunToStop() throws {
        let queued = Presentation.revisionBanner(runs: [try TestData.revisionRun("q2d8kp", status: "queued")], documentId: "aaaaaa")
        XCTAssertEqual(queued, .init(runId: "q2d8kp", title: "排队修订中", isRunning: false))

        let running = Presentation.revisionBanner(runs: [try TestData.revisionRun("r2d8kp", status: "running")], documentId: "aaaaaa")
        XCTAssertEqual(running, .init(runId: "r2d8kp", title: "Alfred 正在修订", isRunning: true))
    }

    func testThereIsNoBannerOnceTheRunHasEnded() throws {
        for status in ["done", "stopped", "failed", "lost"] {
            XCTAssertNil(Presentation.revisionBanner(runs: [try TestData.revisionRun("r2d8kp", status: status)], documentId: "aaaaaa"), status)
        }
        XCTAssertNil(Presentation.revisionBanner(runs: [], documentId: "aaaaaa"))
    }

    func testOnlyARevisionRunOfThisDocumentMakesABanner() throws {
        let otherDocument = try TestData.revisionRun("r2d8kp", documentId: "bbbbbb", status: "running")
        let chatRun = try TestData.run("c2d8kp", kind: "task", status: "running")

        XCTAssertNil(Presentation.revisionBanner(runs: [otherDocument, chatRun], documentId: "aaaaaa"))
    }

    func testARunningRunShowsBeforeOneThatWaits() throws {
        let runs = [
            try TestData.revisionRun("q2d8kp", status: "queued", startedAt: "2026-10-27T01:05:00.000Z"),
            try TestData.revisionRun("r2d8kp", status: "running", startedAt: "2026-10-27T01:00:00.000Z"),
        ]

        XCTAssertEqual(Presentation.revisionBanner(runs: runs, documentId: "aaaaaa")?.runId, "r2d8kp")
    }

    func testTheBannerComesFromTheDetailsRunsAndFollowsTheStream() throws {
        // The detail saw the run queued; the stream has since told that it runs, and then that it is done.
        let loaded = [try TestData.revisionRun("r2d8kp", status: "queued")]
        var timeline = try TestData.timeline([TestData.revisionRunEvent(1, run: TestData.revisionRunObject("r2d8kp", status: "running"))])
        XCTAssertEqual(Presentation.revisionBanner(runs: RunPresentation.merged(loaded: loaded, timeline: timeline), documentId: "aaaaaa")?.isRunning, true)

        timeline = try TestData.timeline([
            TestData.revisionRunEvent(1, run: TestData.revisionRunObject("r2d8kp", status: "running")),
            TestData.revisionRunEvent(2, run: TestData.revisionRunObject("r2d8kp", status: "done")),
        ])
        XCTAssertNil(Presentation.revisionBanner(runs: RunPresentation.merged(loaded: loaded, timeline: timeline), documentId: "aaaaaa"))
    }

    // MARK: Undo

    func testTheUndoMenuShowsOnlyWhenTheCurrentVersionIsARevision() throws {
        let revised = [
            try TestData.version(v2, reason: "revised", at: "2026-10-27T09:12:00.000Z", runId: "r2d8kp"),
            try TestData.version(v1, reason: "delivered", runId: "k7m2qa"),
        ]
        XCTAssertEqual(Presentation.undoOffer(currentVersion: v2, versions: revised)?.runId, "r2d8kp")

        for reason in ["delivered", "changed", "undone"] {
            let versions = [
                try TestData.version(v2, reason: reason, runId: "r2d8kp"),
                try TestData.version(v1, reason: "revised", runId: "k7m2qa"),
            ]
            XCTAssertNil(Presentation.undoOffer(currentVersion: v2, versions: versions), "a \(reason) version cannot be undone, even over a revision")
        }
    }

    func testAnEarlierRevisionIsNotOffered() throws {
        let versions = [
            try TestData.version(v3, reason: "changed", runId: "t4w9xr"),
            try TestData.version(v2, reason: "revised", runId: "r2d8kp"),
            try TestData.version(v1, reason: "delivered", runId: "k7m2qa"),
        ]

        XCTAssertNil(Presentation.undoOffer(currentVersion: v3, versions: versions))
        XCTAssertNil(Presentation.undoOffer(currentVersion: TestData.commit(9), versions: versions), "a version the list does not hold")
        XCTAssertNil(Presentation.undoOffer(currentVersion: v2, versions: []))
    }

    func testTheConfirmationNamesTheTimeOfTheVersion() throws {
        let at = try XCTUnwrap(ISO8601DateFormatter().date(from: "2026-10-27T09:12:00Z"))
        let offer = Presentation.UndoOffer(runId: "r2d8kp", at: at)

        XCTAssertEqual(offer.question, "撤销 \(RunPresentation.dateTime(at)) 的这次修订？")
    }

    func testARevisionWithoutARunIsNotOffered() throws {
        let versions = [try TestData.version(v2, reason: "revised", runId: nil)]

        XCTAssertNil(Presentation.undoOffer(currentVersion: v2, versions: versions))
    }
}
