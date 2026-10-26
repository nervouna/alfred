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

    // MARK: Versions

    func testAFileIsCachedByPathAndVersion() {
        let first = FileDownload.Key(path: "a.md", version: "v1")
        XCTAssertEqual(first, FileDownload.Key(path: "a.md", version: "v1"))
        XCTAssertNotEqual(first, FileDownload.Key(path: "a.md", version: "v2"), "two versions of one path are two files")
        XCTAssertNotEqual(first, FileDownload.Key(path: "a.md", version: nil), "the live file is not a version")
        XCTAssertNotEqual(first, FileDownload.Key(path: "b.md", version: "v1"), "two paths at one version are two files")
    }

    func testAVersionIsAskedForByItsCommit() async throws {
        let (client, server) = try makeClient(replies: [file("v1 text")])
        let download = FileDownload()

        await download.load(path: "notes/hi.md", version: TestData.commit(1), using: client)

        guard case let .loaded(url) = download.state else { return XCTFail("\(download.state)") }
        XCTAssertEqual(url.lastPathComponent, "hi.md")
        XCTAssertEqual(try String(contentsOf: url, encoding: .utf8), "v1 text")
        XCTAssertEqual(server.log.map(\.path), ["/api/files/notes/hi.md"])
        XCTAssertEqual(server.log.first?.request.url?.query, "version=" + TestData.commit(1))
        XCTAssertEqual(download.key, FileDownload.Key(path: "notes/hi.md", version: TestData.commit(1)))
    }

    func testTwoVersionsNeverShareAFile() async throws {
        let (client, server) = try makeClient(replies: [file("one"), file("two")])
        let download = FileDownload()

        await download.load(path: "a.md", version: "v1", using: client)
        guard case let .loaded(first) = download.state else { return XCTFail("not loaded") }
        await download.load(path: "a.md", version: "v2", using: client)
        guard case let .loaded(second) = download.state else { return XCTFail("not loaded") }

        XCTAssertNotEqual(first, second)
        XCTAssertEqual(try String(contentsOf: first, encoding: .utf8), "one", "the first version's file is still there")
        XCTAssertEqual(try String(contentsOf: second, encoding: .utf8), "two")
        XCTAssertEqual(server.log.compactMap(\.request.url?.query), ["version=v1", "version=v2"])
    }

    func testAVersionTheDownloadHoldsIsNotFetchedAgain() async throws {
        let (client, server) = try makeClient(replies: [file("one"), file("two")])
        let download = FileDownload()

        await download.load(path: "a.md", version: "v1", using: client)
        await download.load(path: "a.md", version: "v2", using: client)
        await download.load(path: "a.md", version: "v1", using: client)

        XCTAssertEqual(server.log.count, 2, "going back to a version is not a request")
        guard case let .loaded(url) = download.state else { return XCTFail("not loaded") }
        XCTAssertEqual(try String(contentsOf: url, encoding: .utf8), "one")
    }

    func testAVersionWhoseFileIsGoneIsFetchedAgain() async throws {
        let (client, server) = try makeClient(replies: [file("one"), file("again")])
        let download = FileDownload()
        await download.load(path: "a.md", version: "v1", using: client)
        guard case let .loaded(first) = download.state else { return XCTFail("not loaded") }
        try FileManager.default.removeItem(at: first.deletingLastPathComponent())

        await download.load(path: "a.md", version: "v1", using: client)

        guard case let .loaded(second) = download.state else { return XCTFail("not loaded") }
        XCTAssertEqual(try String(contentsOf: second, encoding: .utf8), "again")
        XCTAssertEqual(server.log.count, 2)
    }

    func testTheLiveFileIsFetchedEveryTimeItIsAskedFor() async throws {
        let (client, server) = try makeClient(replies: [file("one"), file("two")])
        let download = FileDownload()

        await download.load(path: "a.md", using: client)
        await download.load(path: "a.md", using: client)

        XCTAssertEqual(server.log.count, 2)
        XCTAssertNil(server.log.first?.request.url?.query)
    }

    func testEnsuringLoadedDoesNotFetchWhatIsAlreadyOnScreen() async throws {
        let (client, server) = try makeClient(replies: [file("one"), file("two")])
        let download = FileDownload()

        await download.ensureLoaded(path: "a.md", using: client)
        await download.ensureLoaded(path: "a.md", using: client)
        XCTAssertEqual(server.log.count, 1, "a screen that comes back keeps its file")

        await download.ensureLoaded(path: "a.md", version: "v1", using: client)
        XCTAssertEqual(server.log.count, 2, "another version is another file")
    }

    func testAFileCanBeFetchedWithoutChangingWhatIsOnScreen() async throws {
        let (client, _) = try makeClient(replies: [file("now"), file("before")])
        let download = FileDownload()
        await download.load(path: "a.md", version: "v2", using: client)

        let previous = try await download.file(path: "a.md", version: "v1", using: client)

        XCTAssertEqual(try String(contentsOf: previous, encoding: .utf8), "before")
        XCTAssertEqual(download.key, FileDownload.Key(path: "a.md", version: "v2"))
        guard case let .loaded(url) = download.state else { return XCTFail("not loaded") }
        XCTAssertEqual(try String(contentsOf: url, encoding: .utf8), "now")
    }

    func testEveryFolderGoesWhenTheDownloadDoes() async throws {
        let (client, _) = try makeClient(replies: [file("one"), file("two"), file("three")])
        var download: FileDownload? = FileDownload()
        var folders: [URL] = []
        for version in ["v1", "v2"] {
            await download?.load(path: "a.md", version: version, using: client)
            folders.append(try XCTUnwrap(download?.loadedURL).deletingLastPathComponent())
        }
        let live = try await XCTUnwrap(download).file(path: "a.md", using: client)
        folders.append(live.deletingLastPathComponent())
        XCTAssertTrue(folders.allSatisfy { FileManager.default.fileExists(atPath: $0.path) })

        download = nil

        XCTAssertTrue(folders.allSatisfy { !FileManager.default.fileExists(atPath: $0.path) })
    }

    func testAFailedVersionKeepsItsReasonAndARetryCanSucceed() async throws {
        let (client, _) = try makeClient(replies: [
            StubReply(status: 404, chunks: [Data(#"{"error":"There is no such file."}"#.utf8)]),
            file("back"),
        ])
        let download = FileDownload()

        await download.load(path: "a.md", version: "v1", using: client)
        XCTAssertEqual(download.state, .failed("服务器返回 404：There is no such file."))

        await download.load(path: "a.md", version: "v1", using: client)
        guard case .loaded = download.state else { return XCTFail("\(download.state)") }
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
