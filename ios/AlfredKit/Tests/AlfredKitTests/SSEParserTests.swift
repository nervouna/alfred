import AlfredKit
import Foundation
import XCTest

final class SSEParserTests: XCTestCase {
    private func parse(_ text: String) -> [SSEItem] {
        var parser = SSEParser()
        return parser.feed(contentsOf: Array(text.utf8))
    }

    func testTheSameItemsComeOutWhereverTheBytesAreSplit() {
        let text = "id: 1\nevent: message.created\ndata: {\"a\":\ndata: 1}\n\n: ping\n\ndata: second\n\n"
        let bytes = Array(text.utf8)
        let whole = parse(text)
        XCTAssertEqual(whole.count, 3)
        for split in 0...bytes.count {
            var parser = SSEParser()
            let head = parser.feed(contentsOf: bytes[..<split])
            let tail = parser.feed(contentsOf: bytes[split...])
            XCTAssertEqual(head + tail, whole, "split at byte \(split)")
        }
        var byteByByte = SSEParser()
        var items: [SSEItem] = []
        for byte in bytes {
            if let item = byteByByte.feed(byte) { items.append(item) }
        }
        XCTAssertEqual(items, whole)
    }

    func testLineEndingsCanBeLFCRLFOrCR() {
        let lf = parse("id: 3\ndata: a\ndata: b\n\n")
        XCTAssertEqual(lf, [.frame(SSEFrame(id: "3", event: nil, data: "a\nb"))])
        XCTAssertEqual(parse("id: 3\r\ndata: a\r\ndata: b\r\n\r\n"), lf)
        XCTAssertEqual(parse("id: 3\rdata: a\rdata: b\r\r"), lf)
    }

    func testMultiLineDataIsJoinedWithNewlines() {
        XCTAssertEqual(parse("data: {\ndata:  \"x\": 1\ndata: }\n\n"), [.frame(SSEFrame(id: nil, event: nil, data: "{\n \"x\": 1\n}"))])
    }

    func testCommentsAreHeartbeatsAndDoNotEndAFrame() {
        XCTAssertEqual(parse(": ping\n\n"), [.heartbeat])
        XCTAssertEqual(
            parse("data: a\n: ping\ndata: b\n\n"),
            [.heartbeat, .frame(SSEFrame(id: nil, event: nil, data: "a\nb"))]
        )
    }

    func testAnIDWithoutDataDispatchesNothing() {
        XCTAssertEqual(parse("id: 9\n\n"), [])
        // The id belongs to the frame it is in; it does not carry over to the next one.
        XCTAssertEqual(parse("id: 9\n\ndata: x\n\n"), [.frame(SSEFrame(id: nil, event: nil, data: "x"))])
    }

    func testFieldsFollowTheWhatwgRules() {
        // Exactly one space after the colon is stripped; a line without a colon names a field with an empty value;
        // unknown fields are ignored.
        XCTAssertEqual(
            parse("event:run.updated\ndata:  x\nretry: 5000\ndata\n\n"),
            [.frame(SSEFrame(id: nil, event: "run.updated", data: " x\n"))]
        )
        // An empty data field still dispatches a frame.
        XCTAssertEqual(parse("data\n\n"), [.frame(SSEFrame(id: nil, event: nil, data: ""))])
        // An id that contains NUL is ignored.
        XCTAssertEqual(parse("id: 4\u{0}\ndata: x\n\n"), [.frame(SSEFrame(id: nil, event: nil, data: "x"))])
    }

    func testTheFixturesStreamBackToTheSameStreamEvents() throws {
        // Stored events go out with an id line and live events without one. Each file's JSON is written
        // line by line as data lines, so a frame's data is several lines joined with newlines.
        var text = ""
        var expected: [StreamEvent] = []
        var storedCount = 0
        for file in try Fixtures.jsonFiles(in: "events") + Fixtures.jsonFiles(in: "live") {
            let body = try String(contentsOf: file, encoding: .utf8)
            if let object = try JSONSerialization.jsonObject(with: Data(body.utf8)) as? [String: Any],
               let id = object["id"] as? Int {
                text += "id: \(id)\n"
                storedCount += 1
            }
            for line in body.dropLast().split(separator: "\n", omittingEmptySubsequences: false) {
                text += "data: \(line)\n"
            }
            text += "\n"
            expected.append(try JSONDecoder().decode(StreamEvent.self, from: Data(contentsOf: file)))
        }
        let frames = parse(text).compactMap { item -> SSEFrame? in
            if case let .frame(frame) = item { return frame }
            return nil
        }
        XCTAssertEqual(frames.count, expected.count)
        XCTAssertEqual(frames.filter { $0.id != nil }.count, storedCount)
        let decoded = try frames.map { try JSONDecoder().decode(StreamEvent.self, from: Data($0.data.utf8)) }
        XCTAssertEqual(decoded, expected)
    }
}
