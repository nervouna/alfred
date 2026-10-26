import AlfredKit
import XCTest

@testable import Alfred

final class DocumentListTests: XCTestCase {
    private func date(_ text: String) -> Date {
        (try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(text)) ?? .distantPast
    }

    func testDocumentsComeFromAlfredsMessagesAndTheFilesOfRuns() throws {
        let timeline = try TestData.timeline([
            TestData.messageEvent(1, id: "m1", direction: "out", text: "给你", files: ["notes/a.md"], at: "2026-10-26T08:00:00.000Z"),
            // What the owner attached is not something Alfred delivered or wrote.
            TestData.messageEvent(2, id: "m2", direction: "in", files: ["inbox/2026-10-26/photo.png"], at: "2026-10-26T08:05:00.000Z"),
            TestData.runEvent(
                3,
                run: TestData.runObject("r1", startedAt: "2026-10-26T08:50:00.000Z", endedAt: "2026-10-26T09:00:00.000Z", files: ["reports/b.md"]),
                at: "2026-10-26T09:00:00.000Z"
            ),
        ])
        let loaded = [try TestData.run("r2", startedAt: "2026-10-26T06:50:00.000Z", endedAt: "2026-10-26T07:00:00.000Z", files: ["reports/c.html"])]

        let entries = DocumentList.entries(timeline: timeline, loadedRuns: loaded)

        XCTAssertEqual(entries.map(\.path), ["reports/b.md", "notes/a.md", "reports/c.html"], "newest first")
        XCTAssertEqual(entries.map(\.date), [date("2026-10-26T09:00:00.000Z"), date("2026-10-26T08:00:00.000Z"), date("2026-10-26T07:00:00.000Z")])
    }

    func testAPathThatCameSeveralWaysShowsOnceWithItsNewestDate() throws {
        let timeline = try TestData.timeline([
            TestData.messageEvent(1, id: "m1", direction: "out", files: ["notes/a.md"], at: "2026-10-26T08:00:00.000Z"),
            TestData.messageEvent(2, id: "m2", direction: "out", files: ["notes/a.md", "notes/b.md"], at: "2026-10-26T09:00:00.000Z"),
            TestData.runEvent(3, run: TestData.runObject("r1", endedAt: "2026-10-26T10:00:00.000Z", files: ["notes/a.md"]), at: "2026-10-26T10:00:00.000Z"),
        ])
        let loaded = [try TestData.run("r2", startedAt: "2026-10-26T05:00:00.000Z", endedAt: "2026-10-26T06:00:00.000Z", files: ["notes/a.md"])]

        let entries = DocumentList.entries(timeline: timeline, loadedRuns: loaded)

        XCTAssertEqual(entries.map(\.path), ["notes/a.md", "notes/b.md"])
        XCTAssertEqual(entries.first?.date, date("2026-10-26T10:00:00.000Z"))
    }

    func testARunWithoutAnEndDatesItsFilesByItsStart() throws {
        let loaded = [
            try TestData.run("r1", status: "running", startedAt: "2026-10-26T08:00:00.000Z", files: ["a.md"]),
            try TestData.run("r2", startedAt: "2026-10-26T07:00:00.000Z", endedAt: "2026-10-26T07:30:00.000Z", files: ["b.md"]),
        ]
        let entries = DocumentList.entries(timeline: Timeline(), loadedRuns: loaded)
        XCTAssertEqual(entries.map(\.path), ["a.md", "b.md"])
        XCTAssertEqual(entries.first?.date, date("2026-10-26T08:00:00.000Z"))
    }

    func testTheTimelinesRunReplacesTheLoadedOneWithTheSameId() throws {
        // The run was loaded as running with one file; the stream has since told us it wrote another.
        let loaded = [try TestData.run("r1", status: "running", startedAt: "2026-10-26T08:00:00.000Z", files: ["a.md"])]
        let timeline = try TestData.timeline([
            TestData.runEvent(
                1,
                run: TestData.runObject("r1", endedAt: "2026-10-26T08:10:00.000Z", files: ["a.md", "b.md"]),
                at: "2026-10-26T08:10:00.000Z"
            ),
        ])
        let entries = DocumentList.entries(timeline: timeline, loadedRuns: loaded)
        XCTAssertEqual(Set(entries.map(\.path)), ["a.md", "b.md"])
    }

    func testEntriesWithTheSameDateKeepAStableOrder() throws {
        let loaded = [try TestData.run("r1", endedAt: "2026-10-26T08:10:00.000Z", files: ["b.md", "a.md", "c/d.md"])]
        let entries = DocumentList.entries(timeline: Timeline(), loadedRuns: loaded)
        XCTAssertEqual(entries.map(\.path), ["a.md", "b.md", "c/d.md"])
    }

    func testNothingLoadedMeansNoDocuments() {
        XCTAssertEqual(DocumentList.entries(timeline: Timeline(), loadedRuns: []), [])
    }

    func testAnEntryKnowsItsNameAndFolder() {
        let at = Date(timeIntervalSince1970: 0)
        XCTAssertEqual(DocumentEntry(path: "notes/2026/hi.md", date: at).name, "hi.md")
        XCTAssertEqual(DocumentEntry(path: "notes/2026/hi.md", date: at).folder, "notes/2026")
        XCTAssertEqual(DocumentEntry(path: "hi.md", date: at).name, "hi.md")
        XCTAssertEqual(DocumentEntry(path: "hi.md", date: at).folder, "")
    }
}
