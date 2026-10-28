import AlfredKit
import Foundation
import XCTest

final class DocumentTests: XCTestCase {
    private func document(path: String) throws -> AlfredDocument {
        let json = #"{"id":"r4f7ma","path":"\#(path)","title":"周报","kind":"markdown","version":"5d726c9ddcb2d6a8fad41e6213426bdeb94c6acd","createdAt":"2026-10-26T08:00:00.000Z","updatedAt":"2026-10-26T08:00:00.000Z"}"#
        return try JSONDecoder().decode(AlfredDocument.self, from: Data(json.utf8))
    }

    func testADocumentUnderTheWorkspaceTrashIsTrashed() throws {
        XCTAssertTrue(try document(path: ".trash/a.md").isTrashed)
        XCTAssertTrue(try document(path: ".trash/x/a.md").isTrashed)
    }

    func testADocumentElsewhereIsNotTrashed() throws {
        XCTAssertFalse(try document(path: "notes/.trash/a.md").isTrashed)
        XCTAssertFalse(try document(path: ".trashed/a.md").isTrashed)
        XCTAssertFalse(try document(path: "a.md").isTrashed)
    }
}
