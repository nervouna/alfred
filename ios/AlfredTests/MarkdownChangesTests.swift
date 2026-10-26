import XCTest

@testable import Alfred

final class MarkdownChangesTests: XCTestCase {
    /// The text of the blocks of `markdown` that `changed` marks, in document order.
    private func marked(_ previous: String?, _ current: String) -> [String] {
        let blocks = MarkdownDocument.blocks(from: current)
        let ids = MarkdownChanges.changedBlockIds(previous: previous, current: current)
        return blocks.filter { ids.contains($0.id) }.map { $0.text.plainText }
    }

    private func document(_ blocks: String...) -> String {
        blocks.joined(separator: "\n\n") + "\n"
    }

    // MARK: The cases

    func testNothingChangedMarksNothing() {
        let text = document("# 标题", "第一段。", "第二段。")
        XCTAssertEqual(marked(text, text), [])
    }

    func testAChangedParagraphIsMarked() {
        let before = document("# 标题", "第一段。", "第二段。")
        let after = document("# 标题", "第一段改了。", "第二段。")
        XCTAssertEqual(marked(before, after), ["第一段改了。"])
    }

    func testAnAddedParagraphIsMarkedWherever() {
        let before = document("# 标题", "第一段。", "第二段。")
        XCTAssertEqual(marked(before, document("# 标题", "新的一段。", "第一段。", "第二段。")), ["新的一段。"], "in front")
        XCTAssertEqual(marked(before, document("# 标题", "第一段。", "新的一段。", "第二段。")), ["新的一段。"], "in the middle")
        XCTAssertEqual(marked(before, document("# 标题", "第一段。", "第二段。", "新的一段。")), ["新的一段。"], "at the end")
    }

    func testARemovedParagraphMarksNothing() {
        let before = document("# 标题", "第一段。", "第二段。", "第三段。")
        XCTAssertEqual(marked(before, document("# 标题", "第一段。", "第三段。")), [])
        XCTAssertEqual(marked(before, document("# 标题")), [])
    }

    func testAChangeAndAnAdditionAreBothMarked() {
        let before = document("# 标题", "摘要。", "展望。")
        let after = document("# 标题", "摘要变了。", "展望。", "新的风险。")
        XCTAssertEqual(marked(before, after), ["摘要变了。", "新的风险。"])
    }

    func testAMovedBlockIsMarkedAtItsNewPlaceAndItsNeighboursAreNot() {
        let before = document("甲。", "乙。", "丙。", "丁。")
        XCTAssertEqual(marked(before, document("甲。", "丙。", "丁。", "乙。")), ["乙。"], "moved to the end")
        XCTAssertEqual(marked(before, document("丁。", "甲。", "乙。", "丙。")), ["丁。"], "moved to the front")
    }

    func testSwappingTwoBlocksMarksOneOfThem() {
        let before = document("甲。", "乙。")
        XCTAssertEqual(marked(before, document("乙。", "甲。")).count, 1)
    }

    func testTheFirstVersionMarksNothing() {
        XCTAssertEqual(marked(nil, document("# 标题", "第一段。")), [])
        XCTAssertEqual(MarkdownChanges.changedBlockIds(previous: nil as [MarkdownBlock]?, current: MarkdownDocument.blocks(from: "x")), [])
    }

    func testAnEmptyVersionBeforeMakesEveryBlockNew() {
        XCTAssertEqual(marked("", document("# 标题", "第一段。")), ["标题", "第一段。"])
    }

    func testNothingAfterMarksNothing() {
        XCTAssertEqual(marked(document("# 标题", "第一段。"), ""), [])
    }

    // MARK: What counts as the same text

    func testBlocksAreComparedByTheirTextNotTheirMarkup() {
        let before = document("这是一段文字。", "- 甲\n- 乙")
        let after = document("这是**一段**文字。", "* 甲\n* 乙")
        XCTAssertEqual(marked(before, after), [], "bold or a different bullet is not a different text")
    }

    func testAHeadingThatChangedIsMarked() {
        let before = document("# 标题", "## 展望", "预计稳定。")
        XCTAssertEqual(marked(before, document("# 标题", "## 下周展望", "预计稳定。")), ["下周展望"])
    }

    func testAHeadingOfAnotherLevelOrAParagraphMadeAHeadingIsMarked() {
        let before = document("# 标题", "## 展望", "预计稳定。")
        XCTAssertEqual(marked(before, document("# 标题", "### 展望", "预计稳定。")), ["展望"])
        XCTAssertEqual(marked(before, document("# 标题", "展望", "预计稳定。")), ["展望"])
    }

    func testAListItemAddedIsTheOnlyMarkedBlock() {
        let before = document("# 标题", "- 甲\n- 乙")
        XCTAssertEqual(marked(before, document("# 标题", "- 甲\n- 乙\n- 丙")), ["丙"])
    }

    func testATableIsComparedByItsCells() {
        let table = "| 品种 | 价格 |\n| --- | --- |\n| 阿拉比卡 | 2.40 |\n"
        let changed = "| 品种 | 价格 |\n| --- | --- |\n| 阿拉比卡 | 2.55 |\n"
        let before = document("# 标题", table)
        XCTAssertEqual(marked(before, document("# 标题", table)), [], "the same table")
        let ids = MarkdownChanges.changedBlockIds(previous: before, current: document("# 标题", changed))
        let blocks = MarkdownDocument.blocks(from: document("# 标题", changed))
        XCTAssertEqual(ids.count, 1)
        guard case .table? = ids.first.flatMap({ id in blocks.first { $0.id == id }?.kind }) else {
            return XCTFail("the marked block is not the table: \(ids)")
        }
    }

    func testACodeBlockThatChangedIsMarked() {
        let before = document("```swift\nlet a = 1\n```")
        XCTAssertEqual(marked(before, document("```swift\nlet a = 2\n```")), ["let a = 2"])
        XCTAssertEqual(marked(before, document("```swift\nlet a = 1\n```")), [])
    }

    func testIdenticalBlocksAreMatchedInOrder() {
        let before = document("相同。", "中间。", "相同。")
        XCTAssertEqual(marked(before, document("相同。", "相同。", "中间。", "相同。")), ["相同。"], "one more of the same block is one new block")
    }

    func testTheMarkedIdsAreTheBlocksIds() {
        let after = document("# 标题", "第一段改了。", "第二段。")
        let blocks = MarkdownDocument.blocks(from: after)
        let ids = MarkdownChanges.changedBlockIds(previous: document("# 标题", "第一段。", "第二段。"), current: after)
        XCTAssertEqual(ids, [blocks[1].id])
    }

    // MARK: The seeded report

    func testTheSeededReportMarksTwoBlocksInItsSecondVersionAndOneInItsThird() {
        let first = document("# 咖啡市场周报", "## 摘要", "本周豆价基本持平，进口量略有下降。", "## 价格", "- 阿拉比卡：每磅 2.40 美元\n- 罗布斯塔：每磅 1.10 美元", "## 展望", "预计下周价格保持稳定。")
        let second = document("# 咖啡市场周报", "## 摘要", "本周豆价小幅上涨，进口量明显下降。", "## 价格", "- 阿拉比卡：每磅 2.40 美元\n- 罗布斯塔：每磅 1.10 美元", "## 展望", "预计下周价格保持稳定。", "主要风险是产区天气。")
        let third = document("# 咖啡市场周报", "## 摘要", "本周豆价小幅上涨，进口量明显下降。", "## 价格", "- 阿拉比卡：每磅 2.40 美元\n- 罗布斯塔：每磅 1.10 美元", "## 下周展望", "预计下周价格保持稳定。", "主要风险是产区天气。")
        XCTAssertEqual(marked(nil, first), [])
        XCTAssertEqual(marked(first, second), ["本周豆价小幅上涨，进口量明显下降。", "主要风险是产区天气。"])
        XCTAssertEqual(marked(second, third), ["下周展望"])
    }

    // MARK: The match

    func testTheMatchKeepsTheMostBlocksInOrder() {
        // Every block of the older list but "c" is in the newer one, in order; "x" and "y" are new.
        let unmatched = MarkdownChanges.unmatchedIndices(previous: ["a", "b", "c", "d", "e"], current: ["a", "x", "b", "d", "y", "e"])
        XCTAssertEqual(unmatched, [1, 4])
    }

    func testListsWithNothingInCommonMarkEveryBlockOfTheNewerOne() {
        XCTAssertEqual(MarkdownChanges.unmatchedIndices(previous: ["a", "b"], current: ["x", "y", "z"]), [0, 1, 2])
    }

    func testTooLargeAMatchMarksTheBlocksBetweenTheCommonStartAndEnd() {
        let previous = ["start", "a", "b", "c", "end"]
        let current = ["start", "x", "a", "c", "y", "end"]
        XCTAssertEqual(MarkdownChanges.unmatchedIndices(previous: previous, current: current), [1, 4])
        XCTAssertEqual(
            MarkdownChanges.unmatchedIndices(previous: previous, current: current, maxCells: 4),
            [1, 2, 3, 4],
            "past the limit the whole middle counts as changed"
        )
    }

    func testALongDocumentWithOneEditIsMatchedAtOnceFromItsEnds() {
        let previous = (0..<20_000).map { "block \($0)" }
        var current = previous
        current[10_000] = "changed"
        XCTAssertEqual(MarkdownChanges.unmatchedIndices(previous: previous, current: current), [10_000])
    }
}
