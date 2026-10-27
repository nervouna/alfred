import AlfredKit
import XCTest

@testable import Alfred

final class IdeaPresentationTests: XCTestCase {
    // MARK: Reasons

    func testTheFiveReasonsHaveTheirChineseLabelsInTheOrderTheDialogListsThem() {
        XCTAssertEqual(
            IdeaPresentation.reasons.map(\.rawValue),
            ["not-interested", "already-doing", "not-now", "too-expensive", "wrong-direction"]
        )
        XCTAssertEqual(
            IdeaPresentation.reasons.map(IdeaPresentation.reasonLabel),
            ["不感兴趣", "已经在做了", "时机不对", "太贵", "方向不对"]
        )
    }

    func testAReasonThisAppDoesNotKnowShowsAsTheServerSentIt() {
        XCTAssertEqual(IdeaPresentation.reasonLabel(RejectionReason(rawValue: "boring")), "boring")
    }

    // MARK: The line about the last generation

    func testAGenerationThatAddedNoneSaysItsNote() throws {
        let generation = try TestData.generation(note: "最近的对话多是在测试功能，暂时没有值得提的。")
        XCTAssertEqual(IdeaPresentation.generationLine(generation), "最近的对话多是在测试功能，暂时没有值得提的。")
        XCTAssertEqual(IdeaPresentation.generationLine(try TestData.generation(trigger: "daily", note: " 今天没有。\n")), "今天没有。")
    }

    func testAGenerationThatAddedNoneAndHasNoNoteSaysThereAreNoNewIdeas() throws {
        XCTAssertEqual(IdeaPresentation.generationLine(try TestData.generation(note: nil)), "这次没有新想法")
        XCTAssertEqual(IdeaPresentation.generationLine(try TestData.generation(note: "  ")), "这次没有新想法")
    }

    func testAFailedGenerationSaysItDidNotWorkAndCanBeTriedAgain() throws {
        XCTAssertEqual(IdeaPresentation.generationLine(try TestData.generation(status: "failed", note: nil)), "这次没想成，可以再试一次")
        XCTAssertEqual(
            IdeaPresentation.generationLine(try TestData.generation(status: "failed", trigger: "daily", note: "不该有的说明")),
            "这次没想成，可以再试一次",
            "a failure has the one text, whatever came with it"
        )
    }

    func testAGenerationThatAddedIdeasHasNoLine() throws {
        XCTAssertNil(IdeaPresentation.generationLine(try TestData.generation(added: 1, note: "想到一个。")))
        XCTAssertNil(IdeaPresentation.generationLine(try TestData.generation(added: 3, note: nil)))
    }

    // MARK: The note

    func testANoteIsTrimmedAndABlankOneIsNoNote() {
        XCTAssertEqual(IdeaPresentation.note(from: "  等报告定稿 \n"), "等报告定稿")
        XCTAssertNil(IdeaPresentation.note(from: ""))
        XCTAssertNil(IdeaPresentation.note(from: " \n\t "))
    }

    func testANoteHoldsAtMost500CharactersAsAlfredCountsThem() {
        let full = String(repeating: "想", count: 500)
        XCTAssertEqual(IdeaPresentation.limited(full), full)
        XCTAssertEqual(IdeaPresentation.limited(full + "多"), full)
        // Alfred counts Unicode scalars: a flag is two, so 250 flags are 500 and one more is too many.
        let flags = String(repeating: "🇹🇼", count: 250)
        XCTAssertEqual(IdeaPresentation.limited(flags), flags)
        XCTAssertEqual(IdeaPresentation.limited(flags + "🇹🇼"), flags)
        XCTAssertEqual(IdeaPresentation.limited("短"), "短")
    }

    // MARK: What an idea is

    func testAOneOffIdeaIsOneOff() throws {
        let idea = try TestData.idea("aaaaaa")
        XCTAssertEqual(IdeaPresentation.kindWords(idea, ownerZone: "Asia/Taipei"), "一次性")
    }

    func testARecurringIdeaShowsItsScheduleInWordsAsTheTaskListDoes() throws {
        let taipei = TimeZone(identifier: "Asia/Taipei") ?? .gmt
        let weekly = try TestData.idea("aaaaaa", kind: "recurring", schedule: ["kind": "weekly", "days": [1], "time": "09:00"])
        XCTAssertEqual(IdeaPresentation.kindWords(weekly, ownerZone: "Asia/Taipei", deviceZone: taipei), "每周一 09:00")
        let daily = try TestData.idea("bbbbbb", kind: "recurring", schedule: ["kind": "daily", "time": "08:00"])
        XCTAssertEqual(IdeaPresentation.kindWords(daily, ownerZone: "Asia/Taipei", deviceZone: taipei), "每天 08:00")
        XCTAssertEqual(
            IdeaPresentation.kindWords(daily, ownerZone: "Asia/Taipei", deviceZone: TimeZone(identifier: "America/New_York") ?? .gmt),
            "每天 08:00（台北时间）",
            "it says whose clock when the phone's reads differently, as the task list does"
        )
        let interval = try TestData.idea("cccccc", kind: "recurring", schedule: ["kind": "interval", "hours": 6])
        XCTAssertEqual(IdeaPresentation.kindWords(interval, ownerZone: nil), "每 6 小时")
    }

    func testTheModelLineShowsTheModelAndTheEstimate() throws {
        XCTAssertEqual(IdeaPresentation.modelLine(try TestData.idea("aaaaaa", model: "haiku", estimateUsd: 0.05)), "haiku · 约 $0.05")
        XCTAssertEqual(IdeaPresentation.modelLine(try TestData.idea("bbbbbb", model: "sonnet", estimateUsd: 0.35)), "sonnet · 约 $0.35")
        XCTAssertEqual(IdeaPresentation.modelLine(try TestData.idea("cccccc", model: "opus", estimateUsd: 15)), "opus · 约 $15.00")
    }

    func testAnEstimateUnderACentIsNotShownAsFree() {
        XCTAssertEqual(IdeaPresentation.estimate(0.004), "约 <$0.01")
        XCTAssertEqual(IdeaPresentation.estimate(0.01), "约 $0.01")
    }

    func testOnlyALongBriefOffersToBeReadInFull() {
        XCTAssertFalse(IdeaPresentation.isLong("写两行笔记。"))
        XCTAssertTrue(IdeaPresentation.isLong(String(repeating: "长", count: 80)))
        XCTAssertTrue(IdeaPresentation.isLong("一\n二\n三\n四"))
    }

    // MARK: History

    func testAnAcceptedIdeaSaysSo() throws {
        let idea = try TestData.idea("aaaaaa", state: "accepted", taskId: "n2c7bq")
        XCTAssertEqual(IdeaPresentation.historyStatus(idea), "已采纳")
        XCTAssertNil(IdeaPresentation.historyNote(idea))
    }

    func testARejectedIdeaShowsItsReasonInChineseAndItsNote() throws {
        let noted = try TestData.idea("aaaaaa", state: "rejected", rejection: ["reason": "not-now", "note": "等这周的报告定稿再说。"])
        XCTAssertEqual(IdeaPresentation.historyStatus(noted), "不要：时机不对")
        XCTAssertEqual(IdeaPresentation.historyNote(noted), "等这周的报告定稿再说。")
        let bare = try TestData.idea("bbbbbb", state: "rejected", rejection: ["reason": "too-expensive"])
        XCTAssertEqual(IdeaPresentation.historyStatus(bare), "不要：太贵")
        XCTAssertNil(IdeaPresentation.historyNote(bare))
    }

    func testAnArchivedIdeaSaysArchived() throws {
        XCTAssertEqual(IdeaPresentation.historyStatus(try TestData.idea("aaaaaa", state: "archived")), "已归档")
    }

    func testAStateThisAppDoesNotKnowShowsAsTheServerSentIt() throws {
        XCTAssertEqual(IdeaPresentation.historyStatus(try TestData.idea("aaaaaa", state: "snoozed")), "snoozed")
    }

    // MARK: 讨论

    func testDiscussingFillsAnEmptyComposerWithTheTitleAndTheBrief() throws {
        let idea = try TestData.idea("aaaaaa", title: "追踪价格", brief: "每周看一次定价页。")
        XCTAssertEqual(IdeaPresentation.discussion(of: idea, after: ""), "关于想法「追踪价格」：\n每周看一次定价页。")
        XCTAssertEqual(IdeaPresentation.discussion(of: idea, after: "  \n"), "关于想法「追踪价格」：\n每周看一次定价页。", "a blank composer holds nothing to keep")
    }

    func testDiscussingKeepsWhatIsAlreadyInTheComposerAndAddsAfterABlankLine() throws {
        let idea = try TestData.idea("aaaaaa", title: "追踪价格", brief: "每周看一次定价页。")
        XCTAssertEqual(
            IdeaPresentation.discussion(of: idea, after: "先说一件事"),
            "先说一件事\n\n关于想法「追踪价格」：\n每周看一次定价页。"
        )
    }
}
