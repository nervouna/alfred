import AlfredKit
import XCTest

final class ReplyPartsTests: XCTestCase {
    private let split = ReplyParts.separator

    func testTheSeparatorIsTheDocumentedLine() {
        XCTAssertEqual(ReplyParts.separator, "<!-- split -->")
    }

    func testTextWithoutASeparatorIsOnePart() {
        XCTAssertEqual(ReplyParts.split("第一行\n第二行"), ["第一行\n第二行"])
        XCTAssertEqual(ReplyParts.split("  trimmed \n"), ["trimmed"])
    }

    func testAnEmptyTextHasNoParts() {
        XCTAssertEqual(ReplyParts.split(""), [])
        XCTAssertEqual(ReplyParts.split("  \n\n"), [])
    }

    func testTwoAndThreeParts() {
        XCTAssertEqual(ReplyParts.split("one\n\(split)\ntwo"), ["one", "two"])
        XCTAssertEqual(ReplyParts.split("one\nmore\n\(split)\ntwo\n\n\(split)\n\nthree"), ["one\nmore", "two", "three"])
    }

    func testSurroundingWhitespaceAroundTheSeparatorLine() {
        XCTAssertEqual(ReplyParts.split("one\n  \(split)\t\ntwo"), ["one", "two"])
        XCTAssertEqual(ReplyParts.split("one\r\n\(split)\r\ntwo"), ["one", "two"])
    }

    func testTheSeparatorMustStandAloneOnItsLine() {
        let text = "one \(split) two\n\(split) after\nbefore \(split)"
        XCTAssertEqual(ReplyParts.split(text), [text])
    }

    func testASeparatorInsideAFencedCodeBlockStays() {
        let code = "```\n\(split)\n```"
        XCTAssertEqual(ReplyParts.split("before\n\(code)\nafter"), ["before\n\(code)\nafter"])
        XCTAssertEqual(ReplyParts.split("a\n\(split)\n\(code)\n\(split)\nb"), ["a", code, "b"])
    }

    func testTildeFencesAndLongerFences() {
        let tilde = "~~~swift\n\(split)\n~~~"
        XCTAssertEqual(ReplyParts.split("\(tilde)\n\(split)\nx"), [tilde, "x"])
        // A shorter run does not close a longer fence, and another character does not either.
        let long = "````\n```\n\(split)\n~~~~\n````"
        XCTAssertEqual(ReplyParts.split("\(long)\n\(split)\nx"), [long, "x"])
    }

    func testAnUnfinishedFenceRunsToTheEnd() {
        let text = "a\n\(split)\n```\ncode\n\(split)\nmore"
        XCTAssertEqual(ReplyParts.split(text), ["a", "```\ncode\n\(split)\nmore"])
    }

    func testBackticksOnALineAreInlineCodeNotAFence() {
        XCTAssertEqual(ReplyParts.split("```code``` inline\n\(split)\nx"), ["```code``` inline", "x"])
    }

    func testEmptyPartsAreLeftOut() {
        XCTAssertEqual(ReplyParts.split("\(split)\none\n\(split)\n\(split)\ntwo\n\(split)"), ["one", "two"])
        XCTAssertEqual(ReplyParts.split("\(split)\n\(split)"), [])
    }
}
