import AlfredKit
import Foundation
import XCTest

final class ResponseFixtureTests: XCTestCase {
    func testEveryResponseFixtureDecodesToItsType() throws {
        let files = try Fixtures.jsonFiles(in: "responses")
        XCTAssertGreaterThanOrEqual(files.count, 4, "an upload, a run list, a run detail and an error")
        let decoder = JSONDecoder()
        for file in files {
            let name = file.lastPathComponent
            let data = try Data(contentsOf: file)
            do {
                switch name {
                case "upload-result.json": _ = try decoder.decode(UploadResult.self, from: data)
                case "run-list.json": _ = try decoder.decode(RunList.self, from: data)
                case "run-detail.json": _ = try decoder.decode(RunDetail.self, from: data)
                case "task-result.json": _ = try decoder.decode(TaskResult.self, from: data)
                case "task-list.json": _ = try decoder.decode(TaskList.self, from: data)
                case "task-detail.json": _ = try decoder.decode(TaskDetail.self, from: data)
                case "document-result.json": _ = try decoder.decode(DocumentResult.self, from: data)
                case "document-list.json": _ = try decoder.decode(DocumentList.self, from: data)
                case "document-detail.json": _ = try decoder.decode(DocumentDetail.self, from: data)
                case "revision-accepted.json": _ = try decoder.decode(RevisionAccepted.self, from: data)
                case "idea-result.json": _ = try decoder.decode(IdeaResult.self, from: data)
                case "idea-accepted.json": _ = try decoder.decode(IdeaAccepted.self, from: data)
                case "idea-generation-accepted.json": _ = try decoder.decode(IdeaGenerationAccepted.self, from: data)
                case "idea-list.json", "idea-list-empty.json", "idea-list-nothing-new.json", "idea-list-failed.json":
                    _ = try decoder.decode(IdeaList.self, from: data)
                case "settings-result.json", "settings-result-beyond-ranges.json": _ = try decoder.decode(SettingsResult.self, from: data)
                case "settings-detail.json": _ = try decoder.decode(SettingsDetail.self, from: data)
                case "error.json": _ = try decoder.decode(ErrorResponse.self, from: data)
                default: XCTFail("\(name) has no response type")
                }
            } catch {
                XCTFail("\(name) does not decode: \(error)")
            }
        }
    }

    func testUploadResultIsAFileUnderInbox() throws {
        let data = try Data(contentsOf: Fixtures.directory.appending(path: "responses/upload-result.json"))
        let result = try JSONDecoder().decode(UploadResult.self, from: data)
        XCTAssertEqual(result.file.path, "inbox/2026-10-25/IMG_0413.jpg")
        XCTAssertEqual(result.file.kind, .image)
    }

    func testRunListIsNewestFirst() throws {
        let data = try Data(contentsOf: Fixtures.directory.appending(path: "responses/run-list.json"))
        let list = try JSONDecoder().decode(RunList.self, from: data)
        XCTAssertGreaterThanOrEqual(list.runs.count, 2)
        let starts = list.runs.map(\.startedAt)
        XCTAssertEqual(starts, starts.sorted(by: >))
    }

    func testRunDetailCarriesItsStepsAndTheSubagentRole() throws {
        let data = try Data(contentsOf: Fixtures.directory.appending(path: "responses/run-detail.json"))
        let detail = try JSONDecoder().decode(RunDetail.self, from: data)
        XCTAssertEqual(detail.run.id, "k7m2qa")
        XCTAssertEqual(detail.steps.map(\.tool), ["WebSearch", "Task", "Write"])
        XCTAssertNil(detail.steps[0].agent)
        XCTAssertEqual(detail.steps[1].agent, "reviewer")
    }

    func testErrorResponseCarriesItsMessage() throws {
        let data = try Data(contentsOf: Fixtures.directory.appending(path: "responses/error.json"))
        let error = try JSONDecoder().decode(ErrorResponse.self, from: data)
        XCTAssertEqual(error.error, "no live or queued run k7m2qa")
    }
}
