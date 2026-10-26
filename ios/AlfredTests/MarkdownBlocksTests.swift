import XCTest

@testable import Alfred

final class MarkdownBlocksTests: XCTestCase {
    private static let document = """
    # Title

    Para with **bold** and [a link](https://example.com/page) and `code`.
    Second line.

    - one
    - two
      - nested

    1. first
    2. second

    > quote
    > > deeper

    ```swift
    let a = 1
    let b = 2
    ```

    ---

    | a | b |
    |---|---|
    | 1 | 2 |
    | 3 | 4 |
    """

    private func blocks(_ markdown: String = document) -> [MarkdownBlock] {
        MarkdownDocument.blocks(from: markdown)
    }

    func testEachBlockOfADocumentComesOutOnceInOrder() {
        let blocks = blocks()
        XCTAssertEqual(blocks.map(\.kind.name), [
            "heading1", "paragraph", "paragraph", "paragraph", "paragraph", "paragraph", "paragraph",
            "paragraph", "paragraph", "code", "rule", "table",
        ])
        XCTAssertEqual(blocks.map(\.id), Array(0..<blocks.count))
    }

    func testHeadingsKeepTheirLevel() {
        let blocks = blocks("# One\n\n## Two\n\n###### Six")
        XCTAssertEqual(blocks.map(\.kind), [.heading(level: 1), .heading(level: 2), .heading(level: 6)])
        XCTAssertEqual(blocks.map(\.text.plainText), ["One", "Two", "Six"])
    }

    func testAParagraphKeepsItsInlineStyleAndLinks() throws {
        let paragraph = try XCTUnwrap(blocks().dropFirst().first)
        XCTAssertEqual(paragraph.kind, .paragraph)
        XCTAssertEqual(paragraph.text.plainText, "Para with bold and a link and code. Second line.")
        let runs = paragraph.text.runs
        XCTAssertTrue(runs.contains { $0.inlinePresentationIntent?.contains(.stronglyEmphasized) == true })
        XCTAssertTrue(runs.contains { $0.inlinePresentationIntent?.contains(.code) == true })
        XCTAssertEqual(runs.compactMap(\.link), [try XCTUnwrap(URL(string: "https://example.com/page"))])
    }

    func testListItemsCarryTheirMarkerAndDepth() {
        let items = Array(blocks().dropFirst(2).prefix(5))
        XCTAssertEqual(items.map(\.text.plainText), ["one", "two", "nested", "first", "second"])
        XCTAssertEqual(items.map(\.marker), ["•", "•", "•", "1.", "2."])
        XCTAssertEqual(items.map(\.listDepth), [1, 1, 2, 1, 1])
        XCTAssertEqual(items.map(\.quoteDepth), [0, 0, 0, 0, 0])
    }

    func testAnOrderedListStartsWhereItSays() {
        let items = blocks("3. three\n4. four")
        XCTAssertEqual(items.map(\.marker), ["3.", "4."])
    }

    func testOnlyTheFirstParagraphOfAListItemHasAMarker() {
        let blocks = blocks("- first para\n\n  second para\n\n- next item")
        XCTAssertEqual(blocks.map(\.text.plainText), ["first para", "second para", "next item"])
        XCTAssertEqual(blocks.map(\.marker), ["•", nil, "•"])
        XCTAssertEqual(blocks.map(\.listDepth), [1, 1, 1])
    }

    func testQuotesNestByDepth() {
        let quotes = Array(blocks().dropFirst(7).prefix(2))
        XCTAssertEqual(quotes.map(\.text.plainText), ["quote", "deeper"])
        XCTAssertEqual(quotes.map(\.quoteDepth), [1, 2])
        XCTAssertEqual(quotes.map(\.listDepth), [0, 0])
    }

    func testAListInsideAQuoteHasBoth() {
        let blocks = blocks("> - quoted item")
        XCTAssertEqual(blocks.map(\.quoteDepth), [1])
        XCTAssertEqual(blocks.map(\.listDepth), [1])
        XCTAssertEqual(blocks.map(\.marker), ["•"])
    }

    func testACodeBlockKeepsItsLinesAndLanguage() throws {
        let code = try XCTUnwrap(blocks().first { $0.kind.name == "code" })
        XCTAssertEqual(code.kind, .code(language: "swift"))
        XCTAssertEqual(code.text.plainText, "let a = 1\nlet b = 2", "the closing newline is dropped")
        XCTAssertEqual(blocks("```\nplain\n```").map(\.kind), [.code(language: nil)])
    }

    func testCodeIsNotReadAsMarkdown() {
        let code = blocks("```\n# not a heading\n- not a list\n**not bold**\n```")
        XCTAssertEqual(code.map(\.kind), [.code(language: nil)])
        XCTAssertEqual(code.first?.text.plainText, "# not a heading\n- not a list\n**not bold**")
    }

    func testATableIsOneBlockWithItsRows() throws {
        let block = try XCTUnwrap(blocks().last)
        guard case let .table(table) = block.kind else { return XCTFail("not a table: \(block.kind)") }
        XCTAssertEqual(table.header.map(\.plainText), ["a", "b"])
        XCTAssertEqual(table.rows.map { $0.map(\.plainText) }, [["1", "2"], ["3", "4"]])
    }

    func testPlainTextIsOneParagraph() {
        let blocks = blocks("你好")
        XCTAssertEqual(blocks.map(\.kind), [.paragraph])
        XCTAssertEqual(blocks.first?.text.plainText, "你好")
    }

    func testAnImageShowsItsAltText() {
        let blocks = blocks("![a chart](https://example.com/chart.png)")
        XCTAssertEqual(blocks.map(\.text.plainText), ["a chart"])
    }

    func testAnEmptyDocumentHasNoBlocks() {
        XCTAssertEqual(blocks(""), [])
        XCTAssertEqual(blocks("\n\n"), [])
    }

    func testBlocksCarryNoPresentationIntent() {
        for block in blocks() {
            XCTAssertNil(block.text.runs.first?.presentationIntent, "\(block.kind)")
        }
    }
}

private extension MarkdownBlock.Kind {
    /// A short name for comparing the shape of a document.
    var name: String {
        switch self {
        case .paragraph: "paragraph"
        case let .heading(level): "heading\(level)"
        case .code: "code"
        case .thematicBreak: "rule"
        case .table: "table"
        }
    }
}
