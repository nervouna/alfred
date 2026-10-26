import XCTest

@testable import Alfred

final class FileViewerKindTests: XCTestCase {
    func testTheViewerIsChosenByExtension() {
        let expected: [FileViewerKind: [String]] = [
            .markdown: ["md", "markdown"],
            .pdf: ["pdf"],
            .image: ["png", "jpg", "jpeg", "gif", "webp", "heic"],
            .text: ["txt", "json", "jsonl", "csv", "tsv", "log", "yaml", "yml", "xml", "js", "ts", "py", "sh", "css"],
            .report: ["html", "htm", "svg"],
            .quickLook: ["docx", "xlsx", "pptx", "mp3", "mov", "zip", "silk", "rtf"],
        ]
        for (kind, extensions) in expected {
            for ext in extensions {
                XCTAssertEqual(FileViewerKind(path: "reports/file.\(ext)"), kind, ext)
            }
        }
    }

    func testTheExtensionIsReadWhateverItsCase() {
        XCTAssertEqual(FileViewerKind(path: "A.MD"), .markdown)
        XCTAssertEqual(FileViewerKind(path: "Report.HTML"), .report)
        XCTAssertEqual(FileViewerKind(path: "scan.PDF"), .pdf)
        XCTAssertEqual(FileViewerKind(path: "photo.HEIC"), .image)
    }

    func testOnlyTheLastPathComponentCounts() {
        XCTAssertEqual(FileViewerKind(path: "site.html/notes"), .quickLook, "a folder named like a report does not make a file one")
        XCTAssertEqual(FileViewerKind(path: "v1.2/readme"), .quickLook)
        XCTAssertEqual(FileViewerKind(path: "v1.2/readme.md"), .markdown)
        XCTAssertEqual(FileViewerKind(path: "archive.tar.gz"), .quickLook)
        XCTAssertEqual(FileViewerKind(path: ".md"), .quickLook, "a dotfile has no extension")
    }

    func testAFileWithoutAnExtensionOpensInQuickLook() {
        XCTAssertEqual(FileViewerKind(path: "Makefile"), .quickLook)
        XCTAssertEqual(FileViewerKind(path: ""), .quickLook)
    }
}
