import XCTest

@testable import Alfred

final class MessageTextTests: XCTestCase {
    private static let message = """
    ## 标题
    - 甲
    - 乙

    > 引用

    `代码` 和 [链接](https://example.com)

    | 列 | 值 |
    |---|---|
    | a | 1 |

    第一行
    第二行
    """

    private func links(_ block: MarkdownBlock) -> [URL] {
        block.text.runs.compactMap(\.link)
    }

    func testAMessageComesOutAsBlocksWithItsLineBreaks() throws {
        let blocks = MessageText.blocks(Self.message)
        XCTAssertEqual(blocks.map(\.kind), [
            .heading(level: 2), .paragraph, .paragraph, .paragraph, .paragraph, .table(try table(blocks)), .paragraph,
        ])
        XCTAssertEqual(blocks.map(\.text.plainText), ["标题", "甲", "乙", "引用", "代码 和 链接", "", "第一行\n第二行"])
        XCTAssertEqual(blocks.map(\.marker), [nil, "•", "•", nil, nil, nil, nil])
        XCTAssertEqual(blocks.map(\.listDepth), [0, 1, 1, 0, 0, 0, 0])
        XCTAssertEqual(blocks.map(\.quoteDepth), [0, 0, 0, 1, 0, 0, 0])
        let cells = try table(blocks)
        XCTAssertEqual(cells.header.map(\.plainText), ["列", "值"])
        XCTAssertEqual(cells.rows.map { $0.map(\.plainText) }, [["a", "1"]])
        XCTAssertEqual(links(blocks[4]), [try XCTUnwrap(URL(string: "https://example.com"))])
    }

    func testOnlyWebLinksStayLinks() throws {
        let blocks = MessageText.blocks(
            "[文件](file:///etc/passwd) [应用](alfred://x) [电话](tel:10086) [相对](notes/a.md) [网页](https://example.com/a) [大写](HTTP://EXAMPLE.COM) https://example.org/b www.apple.com"
        )
        XCTAssertEqual(blocks.count, 1)
        let block = try XCTUnwrap(blocks.first)
        XCTAssertEqual(block.text.plainText, "文件 应用 电话 相对 网页 大写 https://example.org/b www.apple.com", "the text of a removed link stays")
        XCTAssertEqual(links(block).map(\.absoluteString), ["https://example.com/a", "HTTP://EXAMPLE.COM", "https://example.org/b", "http://www.apple.com"])
    }

    func testLinksAreCheckedInEveryKindOfBlock() throws {
        let blocks = MessageText.blocks("""
        # [标题](file:///a)

        - [项](alfred://b)

        > [引](tel:1) [网](https://example.com)

        | [头](file:///c) | h |
        |---|---|
        | [格](tel:2) | [网](https://example.org) |
        """)
        XCTAssertEqual(blocks.map(\.text.plainText), ["标题", "项", "引 网", ""])
        XCTAssertEqual(blocks.flatMap(links).map(\.absoluteString), ["https://example.com"])
        let cells = try table(blocks)
        XCTAssertEqual(cells.header.map(\.plainText), ["头", "h"])
        XCTAssertEqual(cells.rows.map { $0.map(\.plainText) }, [["格", "网"]])
        XCTAssertEqual((cells.header + cells.rows.flatMap { $0 }).flatMap { $0.runs.compactMap(\.link) }.map(\.absoluteString), ["https://example.org"])
    }

    func testTextThatDoesNotParseShowsAsTyped() {
        let blocks = MessageText.blocks("**未闭合")
        XCTAssertEqual(blocks.map(\.kind), [.paragraph])
        XCTAssertEqual(blocks.map(\.text.plainText), ["**未闭合"])
    }

    func testPlainTextHasTheMarkersTabbedTableCellsAndLineBreaks() {
        XCTAssertEqual(
            MessageText.plainText(MessageText.blocks(Self.message)),
            "标题\n• 甲\n• 乙\n引用\n代码 和 链接\n列\t值\na\t1\n第一行\n第二行"
        )
    }

    func testPlainTextHasAnOrderedMarkerOnlyOnAnItemsFirstBlock() {
        let blocks = MessageText.blocks("1. 一\n\n   续\n2. 二")
        XCTAssertEqual(MessageText.plainText(blocks), "1. 一\n续\n2. 二")
    }

    func testPlainTextHasACodeBlocksCodeAndLeavesOutARule() {
        let blocks = MessageText.blocks("前\n\n---\n\n```swift\nlet a = 1\n  let b = 2\n```\n\n后")
        XCTAssertEqual(blocks.map(\.kind.isRule), [false, true, false, false])
        XCTAssertEqual(MessageText.plainText(blocks), "前\nlet a = 1\n  let b = 2\n后")
    }

    func testPlainTextOfNothingIsEmpty() {
        XCTAssertEqual(MessageText.plainText(MessageText.blocks("")), "")
        XCTAssertEqual(MessageText.plainText([]), "")
    }

    private func table(_ blocks: [MarkdownBlock]) throws -> MarkdownTable {
        for block in blocks {
            if case let .table(table) = block.kind { return table }
        }
        throw XCTSkip("no table in \(blocks.map(\.kind))")
    }
}

private extension MarkdownBlock.Kind {
    var isRule: Bool {
        if case .thematicBreak = self { true } else { false }
    }
}
