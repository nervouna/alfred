import AlfredKit
import XCTest

@testable import Alfred

/// The text a passage anchors on and the function that finds a target in it.
final class AnchorTextTests: XCTestCase {
    private let report = """
    # 咖啡周报

    本周豆价小幅上涨，进口量明显下降。

    - 阿拉比卡：每磅 2.40 美元
    - 罗布斯塔：每磅 1.10 美元

    > 预计下周价格保持稳定。

    ```
    let price = 2.40
    ```

    | 品种 | 价格 |
    | --- | --- |
    | 阿拉比卡 | 2.40 |
    """

    /// A selection of `quote` in the first piece that holds it, as a text view would report it.
    private func select(_ quote: String, in text: AnchorText, piece: AnchorText.Piece, of pieceText: String) -> AnnotationTarget? {
        guard let range = pieceText.range(of: quote) else { return nil }
        return text.target(selecting: NSRange(range, in: pieceText), of: quote, in: piece)
    }

    // MARK: The text

    func testAMarkdownTextIsItsBlocksPlainTextJoinedWithNewlines() {
        let text = AnchorText(markdown: "# 标题\n\n第一段 **加粗** 和 [链接](https://example.com)。\n\n- 一\n- 二\n")

        XCTAssertEqual(text.text, "标题\n第一段 加粗 和 链接。\n一\n二")
    }

    func testATableIsOnePiecePerCellAndACodeBlockKeepsItsLines() {
        let text = AnchorText(markdown: report)

        XCTAssertEqual(
            text.text,
            "咖啡周报\n本周豆价小幅上涨，进口量明显下降。\n阿拉比卡：每磅 2.40 美元\n罗布斯塔：每磅 1.10 美元\n预计下周价格保持稳定。\nlet price = 2.40\n品种\n价格\n阿拉比卡\n2.40"
        )
    }

    func testATextDocumentIsItsText() {
        XCTAssertEqual(AnchorText(text: "第一行\n第二行").text, "第一行\n第二行")
    }

    // MARK: Making a target

    func testASelectionKeepsAtMostThirtyTwoCharactersOnEachSide() throws {
        let long = String(repeating: "甲", count: 50) + "目标" + String(repeating: "乙", count: 50)
        let text = AnchorText(text: long)

        let target = try XCTUnwrap(select("目标", in: text, piece: .init(block: 0), of: long))

        XCTAssertEqual(target, .passage(quote: "目标", prefix: String(repeating: "甲", count: 32), suffix: String(repeating: "乙", count: 32)))
    }

    func testAnEmptyPrefixAtTheStartOfTheText() throws {
        let text = AnchorText(text: "咖啡豆价格上涨")

        let target = try XCTUnwrap(select("咖啡", in: text, piece: .init(block: 0), of: "咖啡豆价格上涨"))

        XCTAssertEqual(target, .passage(quote: "咖啡", prefix: "", suffix: "豆价格上涨"))
        XCTAssertEqual(text.locate(target), AnchorText.Placement(piece: .init(block: 0), range: NSRange(location: 0, length: 2)))
    }

    func testTheContextOfAMarkdownPassageReachesIntoTheBlocksAroundIt() throws {
        let text = AnchorText(markdown: "第一段。\n\n第二段。\n\n第三段。")
        let second = AnchorText.Piece(block: 1)

        let target = try XCTUnwrap(select("第二段", in: text, piece: second, of: "第二段。"))

        XCTAssertEqual(target, .passage(quote: "第二段", prefix: "第一段。\n", suffix: "。\n第三段。"))
    }

    func testASelectionOfSomethingElseOrOfWhiteSpaceMakesNoTarget() {
        let text = AnchorText(text: "咖啡  豆")

        XCTAssertNil(text.target(selecting: NSRange(location: 0, length: 2), of: "豆价", in: .init(block: 0)), "the view showed other text")
        XCTAssertNil(text.target(selecting: NSRange(location: 2, length: 2), of: "  ", in: .init(block: 0)), "white space is not a passage")
        XCTAssertNil(text.target(selecting: NSRange(location: 0, length: 0), of: "", in: .init(block: 0)))
        XCTAssertNil(text.target(selecting: NSRange(location: 3, length: 5), of: "豆", in: .init(block: 0)), "past the end of the piece")
        XCTAssertNil(text.target(selecting: NSRange(location: 0, length: 2), of: "咖啡", in: .init(block: 4)), "no such piece")
    }

    func testOffsetsAreUTF16AndEmojiCountAsOneScalar() throws {
        let text = AnchorText(text: "😀咖啡😀")
        let target = try XCTUnwrap(text.target(selecting: NSRange(location: 2, length: 2), of: "咖啡", in: .init(block: 0)))

        XCTAssertEqual(target, .passage(quote: "咖啡", prefix: "😀", suffix: "😀"))
        XCTAssertEqual(text.locate(target)?.range, NSRange(location: 2, length: 2))
        XCTAssertNil(text.target(selecting: NSRange(location: 1, length: 3), of: "\u{FFFD}咖啡", in: .init(block: 0)), "a selection cannot start inside a surrogate pair")
    }

    // MARK: Finding a target

    func testAnExactQuoteIsFoundInItsBlock() throws {
        let text = AnchorText(markdown: report)
        let paragraph = AnchorText.Piece(block: 1)
        let target = try XCTUnwrap(select("进口量", in: text, piece: paragraph, of: "本周豆价小幅上涨，进口量明显下降。"))

        let placement = try XCTUnwrap(text.locate(target))

        XCTAssertEqual(placement.piece, paragraph)
        XCTAssertEqual((("本周豆价小幅上涨，进口量明显下降。") as NSString).substring(with: placement.range), "进口量")
    }

    func testARepeatedQuoteIsDecidedByItsPrefix() throws {
        let body = "苹果很甜。梨很脆。苹果很酸。"
        let text = AnchorText(text: body)
        let target = AnnotationTarget.passage(quote: "苹果", prefix: "梨很脆。", suffix: "")

        XCTAssertEqual(text.locate(target)?.range, NSRange(location: 9, length: 2), "the occurrence after 梨很脆。, not the first")
        XCTAssertEqual(text.locate(.passage(quote: "苹果", prefix: "", suffix: "")), AnchorText.Placement(piece: .init(block: 0), range: NSRange(location: 0, length: 2)), "no context: the first")
    }

    func testARepeatedQuoteIsDecidedByItsSuffix() {
        let body = "苹果很甜。梨很脆。苹果很酸。"
        let text = AnchorText(text: body)

        XCTAssertEqual(text.locate(.passage(quote: "苹果", prefix: "", suffix: "很酸。"))?.range, NSRange(location: 9, length: 2))
        XCTAssertEqual(text.locate(.passage(quote: "苹果", prefix: "", suffix: "很甜。"))?.range, NSRange(location: 0, length: 2))
    }

    func testThePrefixAndTheSuffixCountTogether() {
        // The first occurrence has all of the prefix and one scalar of the suffix, the second one scalar of the prefix and all of the suffix.
        let text = AnchorText(text: "ab-q;abc zz-q;xyz")
        let target = AnnotationTarget.passage(quote: "q", prefix: "ab-", suffix: ";xyz")

        XCTAssertEqual(text.locate(target)?.range, NSRange(location: 12, length: 1))
    }

    func testATieGoesToTheFirstOccurrence() {
        let text = AnchorText(text: "猫 猫 猫")

        XCTAssertEqual(text.locate(.passage(quote: "猫", prefix: "", suffix: ""))?.range, NSRange(location: 0, length: 1))
        XCTAssertEqual(text.locate(.passage(quote: "猫", prefix: "", suffix: " "))?.range, NSRange(location: 0, length: 1), "the first two both have the space after them")
        XCTAssertEqual(text.locate(.passage(quote: "猫", prefix: " ", suffix: " "))?.range, NSRange(location: 2, length: 1), "only the middle one has both")
    }

    func testOverlappingOccurrencesAreAllCandidates() {
        let text = AnchorText(text: "aaa")

        XCTAssertEqual(text.locate(.passage(quote: "aa", prefix: "a", suffix: ""))?.range, NSRange(location: 1, length: 2))
    }

    func testAQuoteThatIsNotThereDoesNotFit() throws {
        let text = AnchorText(markdown: report)

        XCTAssertNil(text.locate(.passage(quote: "完全不同的话", prefix: "本周", suffix: "")))
        XCTAssertNil(text.locate(.passage(quote: "", prefix: "", suffix: "")))
    }

    func testAQuoteAcrossABlockBoundaryDoesNotFit() {
        let text = AnchorText(markdown: "第一段结束。\n\n第二段开始。")

        // "结束。\n第二段" exists in the joined text, but it is two blocks.
        XCTAssertNil(text.locate(.passage(quote: "结束。\n第二段", prefix: "", suffix: "")))
        XCTAssertNil(text.locate(.passage(quote: "结束。第二段", prefix: "", suffix: "")))
        XCTAssertNotNil(text.locate(.passage(quote: "结束。", prefix: "", suffix: "")))
    }

    func testAnOccurrenceInsideABlockIsPreferredToOneAcrossBlocks() {
        let text = AnchorText(markdown: "前面的话\n\n后面的话\n\n前面的话后面的话")

        // Only the third block holds the whole quote.
        XCTAssertEqual(text.locate(.passage(quote: "话后面", prefix: "", suffix: ""))?.piece, AnchorText.Piece(block: 2))
        XCTAssertNil(text.locate(.passage(quote: "前面的话\n后面", prefix: "", suffix: "")))
    }

    func testAQuoteAcrossTableCellsDoesNotFit() throws {
        let text = AnchorText(markdown: report)
        // The header cells are 品种 and 价格; no selection can cover both, and neither can a quote found later.
        XCTAssertNil(text.locate(.passage(quote: "品种\n价格", prefix: "", suffix: "")))
        let cell = AnchorText.Piece(block: 6, cell: 3)
        XCTAssertEqual(text.locate(.passage(quote: "2.40", prefix: "阿拉比卡\n", suffix: ""))?.piece, cell)
    }

    func testAWholeDocumentTargetHasNoPlace() {
        XCTAssertNil(AnchorText(text: "文本").locate(.document))
    }

    func testReanchoringBringsTheContextOfTheNewTextAlong() throws {
        let old = AnchorText(text: "旧的开头。苹果很甜。旧的结尾。")
        let new = AnchorText(text: "新的开头，苹果很甜。新的结尾。")
        let target = try XCTUnwrap(select("苹果", in: old, piece: .init(block: 0), of: "旧的开头。苹果很甜。旧的结尾。"))

        XCTAssertEqual(new.reanchored(target), .passage(quote: "苹果", prefix: "新的开头，", suffix: "很甜。新的结尾。"))
        XCTAssertNil(AnchorText(text: "什么也没有").reanchored(target))
        XCTAssertNil(new.reanchored(.document))
    }

    func testTwoTextsAreToldApart() {
        let first = AnchorText(text: "同样的字")
        let second = AnchorText(text: "同样的字")

        XCTAssertEqual(first, first)
        XCTAssertNotEqual(first, second)
    }
}
