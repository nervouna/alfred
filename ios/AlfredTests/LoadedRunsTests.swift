import AlfredKit
import XCTest

@testable import Alfred

@MainActor
final class LoadedRunsTests: XCTestCase {
    private func makeClient(replies: [StubReply]) throws -> AlfredClient {
        let script = ReplyScript(replies)
        let server = StubServer { _ in script.next() }
        addTeardownBlock { withExtendedLifetime(server) {} }
        return AlfredClient(credentials: try server.credentials(), session: server.session)
    }

    private func list(_ ids: [String]) throws -> StubReply {
        let body = try JSONSerialization.data(withJSONObject: ["runs": ids.map { TestData.runObject($0) }])
        return StubReply(chunks: [body])
    }

    func testLoadingReadsTheServersRuns() async throws {
        let client = try makeClient(replies: [try list(["b", "a"])])
        let loaded = LoadedRuns()
        XCTAssertFalse(loaded.hasLoaded)

        await loaded.load(using: client)

        XCTAssertEqual(loaded.runs.map(\.id), ["b", "a"])
        XCTAssertTrue(loaded.hasLoaded)
        XCTAssertNil(loaded.failure)
    }

    func testAFailedLoadKeepsWhatWasLoadedAndSaysWhy() async throws {
        let client = try makeClient(replies: [try list(["a"]), StubReply(status: 502, chunks: [Data(#"{"error":"bad gateway"}"#.utf8)])])
        let loaded = LoadedRuns()
        await loaded.load(using: client)

        await loaded.load(using: client)

        XCTAssertEqual(loaded.runs.map(\.id), ["a"])
        XCTAssertEqual(loaded.failure, "服务器返回 502：bad gateway")
    }

    func testALaterLoadClearsTheFailure() async throws {
        let client = try makeClient(replies: [StubReply(status: 500), try list(["a"])])
        let loaded = LoadedRuns()
        await loaded.load(using: client)
        XCTAssertNotNil(loaded.failure)
        XCTAssertTrue(loaded.hasLoaded, "a failed attempt still counts as an attempt, so the list stops showing a spinner")

        await loaded.load(using: client)

        XCTAssertNil(loaded.failure)
        XCTAssertEqual(loaded.runs.map(\.id), ["a"])
    }

    func testWithoutAClientNothingLoads() async {
        let loaded = LoadedRuns()
        await loaded.load(using: nil)
        XCTAssertEqual(loaded.runs, [])
        XCTAssertEqual(loaded.failure, "尚未配对")
    }
}
