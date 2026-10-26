import AlfredKit
import Foundation
import XCTest

final class AlfredClientTests: XCTestCase {
    /// A client whose every request goes to `handler`, with the requests it saw.
    private func makeClient(_ handler: @escaping @Sendable (URLRequest) -> StubReply) throws -> (AlfredClient, RequestLog) {
        let log = RequestLog()
        let client = try stubbedClient { request in
            log.record(request)
            return handler(request)
        }
        return (client, log)
    }

    private func assertFails(
        with expected: AlfredError,
        file: StaticString = #filePath,
        line: UInt = #line,
        _ operation: () async throws -> Void
    ) async {
        do {
            try await operation()
            XCTFail("expected \(expected), but the call succeeded", file: file, line: line)
        } catch {
            XCTAssertEqual(error as? AlfredError, expected, file: file, line: line)
        }
    }

    func testPingExpectsNoContentAndSendsTheCredentials() async throws {
        let (client, log) = try makeClient { _ in StubReply(status: 204) }
        try await client.ping()
        let entry = try XCTUnwrap(log.entries.first)
        XCTAssertEqual(entry.request.httpMethod, "GET")
        XCTAssertEqual(try encodedPath(entry.request), "/api/ping")
        assertCredentials(entry.request)
    }

    func testPingFailsOnAnyOtherStatus() async throws {
        let (client, _) = try makeClient { _ in StubReply(status: 200) }
        await assertFails(with: .http(status: 200, message: nil)) { try await client.ping() }
    }

    func testSendPostsTheCommandAsJSONAndAnyTwoHundredIsAccepted() async throws {
        let (client, log) = try makeClient { _ in StubReply(status: 202) }
        let command = try JSONDecoder().decode(Command.self, from: fixture("commands/message-send-files.json"))
        try await client.send(command)
        let entry = try XCTUnwrap(log.entries.first)
        XCTAssertEqual(entry.request.httpMethod, "POST")
        XCTAssertEqual(try encodedPath(entry.request), "/api/commands")
        XCTAssertEqual(entry.request.value(forHTTPHeaderField: "Content-Type"), "application/json")
        try assertSameJSON(entry.body, fixture("commands/message-send-files.json"))
        assertCredentials(entry.request)

        let (duplicate, _) = try makeClient { _ in StubReply(status: 200, chunks: [Data(#"{"accepted":false,"duplicate":true}"#.utf8)]) }
        try await duplicate.send(.runStop(runId: "k7m2qa"))
    }

    func testUploadStreamsTheFileAndPercentEncodesTheName() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString, directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
        let file = directory.appending(path: "photo.jpg")
        let bytes = Data((0..<4096).map { UInt8($0 % 251) })
        try bytes.write(to: file)

        let (client, log) = try makeClient { _ in StubReply(chunks: [((try? fixture("responses/upload-result.json")) ?? Data())]) }
        let uploaded = try await client.upload(fileAt: file, name: "my photo 照片.jpg", contentType: "image/jpeg")
        XCTAssertEqual(uploaded.path, "inbox/2026-10-25/IMG_0413.jpg")
        XCTAssertEqual(uploaded.kind, FileKind.image)

        let entry = try XCTUnwrap(log.entries.first)
        XCTAssertEqual(entry.request.httpMethod, "POST")
        XCTAssertEqual(try encodedPath(entry.request), "/api/uploads")
        XCTAssertEqual(try encodedQuery(entry.request), "name=my%20photo%20%E7%85%A7%E7%89%87.jpg")
        XCTAssertEqual(entry.request.value(forHTTPHeaderField: "Content-Type"), "image/jpeg")
        XCTAssertEqual(entry.body, bytes)
        assertCredentials(entry.request)
    }

    func testUploadWithAProgressCallbackSendsTheSameRequest() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString, directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
        let file = directory.appending(path: "quote.pdf")
        let bytes = Data((0..<2048).map { UInt8($0 % 241) })
        try bytes.write(to: file)

        let (client, log) = try makeClient { _ in StubReply(chunks: [((try? fixture("responses/upload-result.json")) ?? Data())]) }
        let uploaded = try await client.upload(fileAt: file, name: "quote.pdf", contentType: "application/pdf") { fraction in
            XCTAssertTrue((0...1).contains(fraction))
        }
        XCTAssertEqual(uploaded.path, "inbox/2026-10-25/IMG_0413.jpg")
        let entry = try XCTUnwrap(log.entries.first)
        XCTAssertEqual(try encodedQuery(entry.request), "name=quote.pdf")
        XCTAssertEqual(entry.request.value(forHTTPHeaderField: "Content-Type"), "application/pdf")
        XCTAssertEqual(entry.body, bytes)
        assertCredentials(entry.request)
    }

    func testRunsAndRunDetailDecodeTheirFixtures() async throws {
        let (client, log) = try makeClient { request in
            // The list and the detail are answered from the same handler: the path picks the fixture.
            if request.url?.path == "/api/runs" {
                return StubReply(chunks: [(try? fixture("responses/run-list.json")) ?? Data()])
            }
            return StubReply(chunks: [(try? fixture("responses/run-detail.json")) ?? Data()])
        }
        let runs = try await client.runs()
        XCTAssertEqual(runs.map(\.id), ["d8j3sx", "h6w4tz", "k7m2qa"])
        XCTAssertEqual(try encodedPath(try XCTUnwrap(log.entries.first).request), "/api/runs")
        XCTAssertEqual(try XCTUnwrap(log.entries.first).request.httpMethod, "GET")

        let detail = try await client.run(id: "k7m2qa")
        XCTAssertEqual(detail.run.id, "k7m2qa")
        XCTAssertEqual(detail.steps.map(\.tool), ["WebSearch", "Task", "Write"])
        XCTAssertEqual(try encodedPath(try XCTUnwrap(log.entries.last).request), "/api/runs/k7m2qa")
        assertCredentials(try XCTUnwrap(log.entries.last).request)
    }

    func testFileEncodesEachPathSegmentAndSavesTheDownload() async throws {
        let bytes = Data("# VPS\n".utf8)
        let (client, log) = try makeClient { _ in StubReply(chunks: [bytes]) }
        let saved = try await client.file(path: "reports/vps report.md")
        defer { try? FileManager.default.removeItem(at: saved.deletingLastPathComponent()) }
        XCTAssertEqual(saved.lastPathComponent, "vps report.md")
        XCTAssertEqual(try Data(contentsOf: saved), bytes)
        let entry = try XCTUnwrap(log.entries.first)
        XCTAssertEqual(entry.request.httpMethod, "GET")
        XCTAssertEqual(try encodedPath(entry.request), "/api/files/reports/vps%20report.md")
        assertCredentials(entry.request)
    }

    func testRegisterPushPostsTheRegistrationAndExpectsNoContent() async throws {
        let (client, log) = try makeClient { _ in StubReply(status: 204) }
        try await client.registerPush(PushRegistration(
            token: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            environment: .development
        ))
        let entry = try XCTUnwrap(log.entries.first)
        XCTAssertEqual(entry.request.httpMethod, "POST")
        XCTAssertEqual(try encodedPath(entry.request), "/api/push")
        try assertSameJSON(entry.body, fixture("requests/push-registration.json"))
        assertCredentials(entry.request)
    }

    func testErrorsMapToTheirCases() async throws {
        let (unauthorized, _) = try makeClient { _ in StubReply(status: 401) }
        await assertFails(with: .unauthorized) { _ = try await unauthorized.runs() }

        let (forbidden, _) = try makeClient { _ in StubReply(status: 403, chunks: [Data("<html>denied</html>".utf8)]) }
        await assertFails(with: .forbidden) { try await forbidden.ping() }

        let (failing, _) = try makeClient { _ in StubReply(status: 500, chunks: [(try? fixture("responses/error.json")) ?? Data()]) }
        await assertFails(with: .http(status: 500, message: "no live or queued run k7m2qa")) {
            _ = try await failing.run(id: "k7m2qa")
        }

        let (bare, _) = try makeClient { _ in StubReply(status: 500) }
        await assertFails(with: .http(status: 500, message: nil)) { try await bare.send(.runStop(runId: "k7m2qa")) }
    }

    func testTransportErrorsPassThrough() async throws {
        let (client, _) = try makeClient { _ in StubReply(failure: .notConnectedToInternet) }
        do {
            try await client.ping()
            XCTFail("expected a transport error")
        } catch let error as URLError {
            XCTAssertEqual(error.code, .notConnectedToInternet)
        }
    }
}
