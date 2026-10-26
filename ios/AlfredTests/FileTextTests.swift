import XCTest

@testable import Alfred

final class FileTextTests: XCTestCase {
    private func write(_ data: Data) throws -> URL {
        let url = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString + ".txt")
        try data.write(to: url)
        addTeardownBlock { try? FileManager.default.removeItem(at: url) }
        return url
    }

    func testASmallFileIsReadWhole() throws {
        let url = try write(Data("你好\nworld".utf8))
        XCTAssertEqual(try FileText.read(url), FileText.Content(text: "你好\nworld", isTruncated: false))
    }

    func testAFileOverTheLimitShowsItsStartAndSaysSo() throws {
        let url = try write(Data(String(repeating: "abcdefghij", count: 100).utf8))
        let content = try FileText.read(url, limit: 25)
        XCTAssertEqual(content, FileText.Content(text: "abcdefghijabcdefghijabcde", isTruncated: true))
    }

    func testAFileExactlyAtTheLimitIsNotTruncated() throws {
        let url = try write(Data(String(repeating: "a", count: 25).utf8))
        XCTAssertFalse(try FileText.read(url, limit: 25).isTruncated)
    }

    func testBytesThatAreNotUTF8DoNotFailTheRead() throws {
        let url = try write(Data([0x68, 0x69, 0xFF, 0xFE, 0x21]))
        XCTAssertEqual(try FileText.read(url).text, "hi\u{FFFD}\u{FFFD}!")
    }
}
