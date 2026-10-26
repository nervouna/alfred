import AlfredKit
import XCTest

@testable import Alfred

@MainActor
final class FileDownloadTests: XCTestCase {
    private func makeClient(replies: [StubReply]) throws -> (AlfredClient, StubServer) {
        let script = ReplyScript(replies)
        let server = StubServer { _ in script.next() }
        addTeardownBlock { withExtendedLifetime(server) {} }
        return (AlfredClient(credentials: try server.credentials(), session: server.session), server)
    }

    private func file(_ text: String) -> StubReply {
        StubReply(headers: ["Content-Type": "text/plain; charset=utf-8"], chunks: [Data(text.utf8)])
    }

    func testAFileIsDownloadedUnderItsName() async throws {
        let (client, server) = try makeClient(replies: [file("你好")])
        let download = FileDownload()
        XCTAssertEqual(download.state, .loading)

        await download.load(path: "notes/hi.md", using: client)

        guard case let .loaded(url) = download.state else { return XCTFail("\(download.state)") }
        XCTAssertEqual(url.lastPathComponent, "hi.md")
        XCTAssertEqual(try String(contentsOf: url, encoding: .utf8), "你好")
        XCTAssertEqual(server.log.map(\.path), ["/api/files/notes/hi.md"])
    }

    func testAFailureKeepsItsReasonAndARetryCanSucceed() async throws {
        let (client, _) = try makeClient(replies: [
            StubReply(status: 404, chunks: [Data(#"{"error":"There is no such file."}"#.utf8)]),
            file("back"),
        ])
        let download = FileDownload()

        await download.load(path: "gone.md", using: client)
        XCTAssertEqual(download.state, .failed("服务器返回 404：There is no such file."))

        await download.load(path: "gone.md", using: client)
        guard case .loaded = download.state else { return XCTFail("\(download.state)") }
    }

    func testWithoutAClientTheFailureSaysSo() async {
        let download = FileDownload()
        await download.load(path: "a.md", using: nil)
        XCTAssertEqual(download.state, .failed("尚未配对"))
    }

    func testTheTemporaryFileGoesWhenTheDownloadDoes() async throws {
        let (client, _) = try makeClient(replies: [file("x")])
        var download: FileDownload? = FileDownload()
        await download?.load(path: "a.md", using: client)
        guard case let .loaded(url)? = download?.state else { return XCTFail("not loaded") }
        XCTAssertTrue(FileManager.default.fileExists(atPath: url.path))

        download = nil

        XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: url.deletingLastPathComponent().path))
    }

    func testALaterDownloadReplacesTheEarlierFile() async throws {
        let (client, _) = try makeClient(replies: [file("one"), file("two")])
        let download = FileDownload()
        await download.load(path: "a.md", using: client)
        guard case let .loaded(first) = download.state else { return XCTFail("not loaded") }

        await download.load(path: "a.md", using: client)

        guard case let .loaded(second) = download.state else { return XCTFail("not loaded") }
        XCTAssertNotEqual(first, second)
        XCTAssertFalse(FileManager.default.fileExists(atPath: first.path))
        XCTAssertEqual(try String(contentsOf: second, encoding: .utf8), "two")
    }
}

final class LoadFailureTests: XCTestCase {
    func testTheReasonForEachKindOfFailure() {
        XCTAssertEqual(LoadFailure.message(for: AlfredError.unauthorized), "这台设备已被撤销，请重新配对")
        XCTAssertEqual(LoadFailure.message(for: AlfredError.forbidden), "Cloudflare Access 拒绝了请求")
        XCTAssertEqual(LoadFailure.message(for: AlfredError.http(status: 404, message: "There is no such file.")), "服务器返回 404：There is no such file.")
        XCTAssertEqual(LoadFailure.message(for: AlfredError.http(status: 502, message: nil)), "服务器返回 502")
        let offline = URLError(.notConnectedToInternet)
        XCTAssertEqual(LoadFailure.message(for: offline), offline.localizedDescription)
    }
}
