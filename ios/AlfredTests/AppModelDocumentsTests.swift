import AlfredKit
import XCTest

@testable import Alfred

/// The app's documents: kept current by `document.updated` events, loaded from `GET /api/documents`, and forgotten on unpairing.
@MainActor
final class AppModelDocumentsTests: XCTestCase {
    /// A paired model on a fake server whose event stream is scripted: `updates` arrive in order, and the stream stays
    /// open. `list` answers `GET /api/documents` in turn.
    private func makeModel(updates: [EventStreamUpdate] = [], list: [StubReply] = []) throws -> (AppModel, StubServer) {
        let listScript = ReplyScript(list.isEmpty ? [try documents([])] : list)
        let server = StubServer { request in
            request.url?.path == "/api/documents" ? listScript.next() : StubReply(status: 404)
        }
        let model = AppModel(
            store: InMemoryCredentialStore(try server.credentials()),
            session: server.session,
            openStream: { _, _ in AsyncStream { continuation in updates.forEach { continuation.yield($0) } } }
        )
        addTeardownBlock { @MainActor in
            model.background()
            withExtendedLifetime(server) {}
        }
        return (model, server)
    }

    private func documents(_ objects: [[String: Any]]) throws -> StubReply {
        StubReply(chunks: [try TestData.documentList(objects)])
    }

    private func event(_ id: Int, _ document: [String: Any]) throws -> EventStreamUpdate {
        .received(try TestData.streamEvent(TestData.documentEvent(id, document: document)))
    }

    // MARK: Events

    func testDocumentUpdatedEventsAddAndChangeDocuments() async throws {
        let (model, _) = try makeModel(updates: [
            try event(1, TestData.documentObject("aaaaaa", title: "旧标题", updatedAt: "2026-10-26T08:00:00.000Z")),
            try event(2, TestData.documentObject("aaaaaa", title: "新标题", updatedAt: "2026-10-26T09:00:00.000Z")),
            try event(3, TestData.documentObject("bbbbbb", title: "另一份", updatedAt: "2026-10-26T10:00:00.000Z")),
        ])
        model.foreground()

        await eventually { model.documentCatalog.documents.count == 2 }
        XCTAssertEqual(model.documentCatalog.documents.map(\.title), ["另一份", "新标题"])
        XCTAssertEqual(model.timeline.lastEventId, 3, "the timeline still moves its resume point past document events")
    }

    func testAnnotationEventsAreKeptForTheirDocument() async throws {
        let annotation = TestData.annotationObject("g7e4xr", documentId: "aaaaaa")
        let (model, _) = try makeModel(updates: [.received(try TestData.streamEvent(TestData.annotationEvent(1, annotation: annotation)))])
        model.foreground()

        await eventually { !model.documentCatalog.annotations(of: "aaaaaa").isEmpty }
        XCTAssertEqual(model.documentCatalog.annotations(of: "aaaaaa").map(\.id), ["g7e4xr"])
    }

    // MARK: Loading

    func testRefreshingLoadsTheList() async throws {
        let (model, server) = try makeModel(list: [try documents([
            TestData.documentObject("aaaaaa", title: "周报", updatedAt: "2026-10-26T09:00:00.000Z"),
            TestData.documentObject("bbbbbb", path: "reports/overview.html", title: "总览", kind: "html", updatedAt: "2026-10-26T10:00:00.000Z"),
        ])])
        XCTAssertFalse(model.documentCatalog.hasLoaded)

        await model.refreshDocuments()

        XCTAssertTrue(model.documentCatalog.hasLoaded)
        XCTAssertEqual(model.documentCatalog.documents.map(\.title), ["总览", "周报"])
        XCTAssertNil(model.documentFailure)
        XCTAssertEqual(server.requests(to: "/api/documents").count, 1)
    }

    func testALoadedListDoesNotUndoANewerEvent() async throws {
        let (model, _) = try makeModel(
            updates: [try event(1, TestData.documentObject("aaaaaa", version: TestData.commit(2), updatedAt: "2026-10-26T10:00:00.000Z"))],
            list: [try documents([TestData.documentObject("aaaaaa", version: TestData.commit(1), updatedAt: "2026-10-26T09:00:00.000Z")])]
        )
        model.foreground()
        await eventually { model.documentCatalog.document(id: "aaaaaa") != nil }

        await model.refreshDocuments()

        XCTAssertEqual(model.documentCatalog.document(id: "aaaaaa")?.version, TestData.commit(2))
    }

    func testAFailedLoadSaysWhyWithoutAnAlertAndKeepsTheDocuments() async throws {
        let (model, _) = try makeModel(
            updates: [try event(1, TestData.documentObject("aaaaaa"))],
            list: [
                StubReply(status: 502, chunks: [Data(#"{"error":"bad gateway"}"#.utf8)]),
                try documents([TestData.documentObject("aaaaaa")]),
            ]
        )
        model.foreground()
        await eventually { model.documentCatalog.documents.count == 1 }

        await model.refreshDocuments()
        XCTAssertEqual(model.documentFailure, "服务器返回 502：bad gateway")
        XCTAssertNil(model.actionFailure)
        XCTAssertEqual(model.documentCatalog.documents.count, 1)

        await model.refreshDocuments()
        XCTAssertNil(model.documentFailure)
    }

    // MARK: Unpairing

    func testUnpairingForgetsTheDocuments() async throws {
        let (model, _) = try makeModel(
            updates: [try event(1, TestData.documentObject("aaaaaa"))],
            list: [StubReply(status: 500)]
        )
        model.foreground()
        await eventually { model.documentCatalog.documents.count == 1 }
        await model.refreshDocuments()
        XCTAssertNotNil(model.documentFailure)

        model.unpair()

        XCTAssertEqual(model.documentCatalog, DocumentCatalog())
        XCTAssertNil(model.documentFailure)
    }
}
