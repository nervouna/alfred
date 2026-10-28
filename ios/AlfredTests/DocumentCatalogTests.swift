import AlfredKit
import XCTest

@testable import Alfred

final class DocumentCatalogTests: XCTestCase {
    private func catalog(_ documents: [[String: Any]]) throws -> DocumentCatalog {
        var catalog = DocumentCatalog()
        catalog.load(try JSONDecoder().decode(DocumentList.self, from: TestData.documentList(documents)))
        return catalog
    }

    // MARK: Loading and order

    func testALoadedListIsKeptNewestUpdatedFirst() throws {
        let catalog = try catalog([
            TestData.documentObject("aaaaaa", updatedAt: "2026-10-26T09:00:00.000Z"),
            TestData.documentObject("bbbbbb", updatedAt: "2026-10-26T11:00:00.000Z"),
            TestData.documentObject("cccccc", updatedAt: "2026-10-26T10:00:00.000Z"),
        ])
        XCTAssertEqual(catalog.documents.map(\.id), ["bbbbbb", "cccccc", "aaaaaa"])
        XCTAssertEqual(catalog.document(id: "cccccc")?.id, "cccccc")
        XCTAssertNil(catalog.document(id: "zzzzzz"))
    }

    func testDocumentsUpdatedTogetherKeepAStableOrder() throws {
        let catalog = try catalog([TestData.documentObject("bbbbbb"), TestData.documentObject("aaaaaa")])
        XCTAssertEqual(catalog.documents.map(\.id), ["aaaaaa", "bbbbbb"])
    }

    func testLoadingMarksTheCatalogLoaded() throws {
        XCTAssertFalse(DocumentCatalog().hasLoaded)
        XCTAssertTrue(try catalog([]).hasLoaded)
    }

    // MARK: document.updated events

    func testANewDocumentAppears() throws {
        var catalog = try catalog([TestData.documentObject("aaaaaa", updatedAt: "2026-10-26T09:00:00.000Z")])
        let delivered = TestData.documentObject("bbbbbb", title: "新文档", updatedAt: "2026-10-26T10:00:00.000Z")
        catalog.apply(try TestData.streamEvent(TestData.documentEvent(7, document: delivered)))
        XCTAssertEqual(catalog.documents.map(\.id), ["bbbbbb", "aaaaaa"])
        XCTAssertEqual(catalog.document(id: "bbbbbb")?.title, "新文档")
    }

    func testAChangedDocumentTakesItsNewVersion() throws {
        var catalog = try catalog([TestData.documentObject("aaaaaa", version: TestData.commit(1))])
        let changed = TestData.documentObject("aaaaaa", version: TestData.commit(2), updatedAt: "2026-10-26T09:00:00.000Z")
        catalog.apply(try TestData.streamEvent(TestData.documentEvent(8, document: changed)))
        XCTAssertEqual(catalog.documents.map(\.id), ["aaaaaa"])
        XCTAssertEqual(catalog.document(id: "aaaaaa")?.version, TestData.commit(2))
    }

    func testAnOlderVersionOfADocumentIsIgnored() throws {
        var catalog = try catalog([TestData.documentObject("aaaaaa", title: "新", updatedAt: "2026-10-26T10:00:00.000Z")])
        let older = TestData.documentObject("aaaaaa", title: "旧", updatedAt: "2026-10-26T09:00:00.000Z")
        catalog.apply(try TestData.streamEvent(TestData.documentEvent(2, document: older)))
        XCTAssertEqual(catalog.document(id: "aaaaaa")?.title, "新", "a replayed event must not undo a newer version")
    }

    func testALoadMergesWithWhatEventsAlreadyTold() throws {
        var catalog = DocumentCatalog()
        // The stream was quicker than the request: it told of a change, and of a document the list does not have yet.
        catalog.apply(try TestData.streamEvent(TestData.documentEvent(
            1, document: TestData.documentObject("aaaaaa", version: TestData.commit(2), updatedAt: "2026-10-26T10:00:00.000Z")
        )))
        catalog.apply(try TestData.streamEvent(TestData.documentEvent(
            2, document: TestData.documentObject("cccccc", updatedAt: "2026-10-26T11:00:00.000Z")
        )))

        catalog.load(try JSONDecoder().decode(DocumentList.self, from: TestData.documentList([
            TestData.documentObject("aaaaaa", version: TestData.commit(1), updatedAt: "2026-10-26T09:00:00.000Z"),
            TestData.documentObject("bbbbbb", updatedAt: "2026-10-26T08:00:00.000Z"),
        ])))

        XCTAssertEqual(catalog.document(id: "aaaaaa")?.version, TestData.commit(2), "a stale list does not undo a newer event")
        XCTAssertEqual(Set(catalog.documents.map(\.id)), ["aaaaaa", "bbbbbb", "cccccc"], "a document only the stream knows is kept")
    }

    func testOtherEventsChangeNothing() throws {
        var catalog = try catalog([TestData.documentObject("aaaaaa")])
        let before = catalog
        catalog.apply(try TestData.streamEvent(TestData.taskEvent(3, task: TestData.taskObject("tttttt"))))
        catalog.apply(try TestData.streamEvent(TestData.runEvent(4, run: TestData.runObject("rrrrrr"), at: "2026-10-26T08:00:00.000Z")))
        catalog.apply(try TestData.streamEvent(TestData.messageEvent(5, id: "m1", direction: "out", text: "hi", at: "2026-10-26T08:00:00.000Z")))
        XCTAssertEqual(catalog, before)
    }

    // MARK: document.removed events

    func testARemovedDocumentLeavesTheCatalog() throws {
        var catalog = try catalog([
            TestData.documentObject("aaaaaa", taskId: "tttttt", updatedAt: "2026-10-26T09:00:00.000Z"),
            TestData.documentObject("bbbbbb", updatedAt: "2026-10-26T10:00:00.000Z"),
        ])
        catalog.apply(try TestData.streamEvent(TestData.documentRemovedEvent(5, id: "aaaaaa")))
        XCTAssertEqual(catalog.documents.map(\.id), ["bbbbbb"])
        XCTAssertNil(catalog.document(id: "aaaaaa"))
        XCTAssertEqual(catalog.documents(taskId: "tttttt"), [])
        catalog.apply(try TestData.streamEvent(TestData.documentRemovedEvent(6, id: "zzzzzz")))
        XCTAssertEqual(catalog.documents.map(\.id), ["bbbbbb"], "an unknown document is nothing to remove")
    }

    func testRemovingADocumentDropsItsAnnotations() throws {
        var catalog = try catalog([TestData.documentObject("aaaaaa"), TestData.documentObject("bbbbbb")])
        catalog.apply(try TestData.streamEvent(TestData.annotationEvent(1, annotation: TestData.annotationObject("g7e4xr", documentId: "aaaaaa"))))
        catalog.apply(try TestData.streamEvent(TestData.annotationEvent(2, annotation: TestData.annotationObject("m5t8bq", documentId: "bbbbbb"))))
        catalog.apply(try TestData.streamEvent(TestData.documentRemovedEvent(3, id: "aaaaaa")))
        XCTAssertEqual(catalog.annotations(of: "aaaaaa"), [])
        XCTAssertEqual(catalog.annotations(of: "bbbbbb").map(\.id), ["m5t8bq"], "the other documents keep theirs")
    }

    func testADocumentUpdatedAfterItsRemovalIsBack() throws {
        var catalog = try catalog([TestData.documentObject("aaaaaa", path: "notes/a.md", updatedAt: "2026-10-26T09:00:00.000Z")])
        catalog.apply(try TestData.streamEvent(TestData.documentRemovedEvent(2, id: "aaaaaa")))
        XCTAssertEqual(catalog.documents, [])

        let restored = TestData.documentObject("aaaaaa", path: "notes/a.md", updatedAt: "2026-10-26T11:00:00.000Z")
        catalog.apply(try TestData.streamEvent(TestData.documentEvent(3, document: restored)))
        XCTAssertEqual(catalog.documents.map(\.id), ["aaaaaa"])
        XCTAssertEqual(catalog.document(id: "aaaaaa"), try TestData.document("aaaaaa", path: "notes/a.md", updatedAt: "2026-10-26T11:00:00.000Z"))
    }

    func testReplayingAnUpdateThenItsRemovalFromAnEmptyCatalogLeavesItEmpty() throws {
        var catalog = DocumentCatalog()
        catalog.apply(try TestData.streamEvent(TestData.documentEvent(1, document: TestData.documentObject("aaaaaa", updatedAt: "2026-10-26T09:00:00.000Z"))))
        catalog.apply(try TestData.streamEvent(TestData.annotationEvent(2, annotation: TestData.annotationObject("g7e4xr", documentId: "aaaaaa"))))
        catalog.apply(try TestData.streamEvent(TestData.documentRemovedEvent(3, id: "aaaaaa")))
        XCTAssertEqual(catalog.documents, [])
        XCTAssertNil(catalog.document(id: "aaaaaa"))
        XCTAssertEqual(catalog.annotations(of: "aaaaaa"), [])
        XCTAssertEqual(catalog, DocumentCatalog(), "nothing is left of it")
    }

    // MARK: A task's documents

    func testATasksDocumentsAreThoseThatNameItNewestFirst() throws {
        let catalog = try catalog([
            TestData.documentObject("aaaaaa", taskId: "tttttt", updatedAt: "2026-10-26T09:00:00.000Z"),
            TestData.documentObject("bbbbbb", updatedAt: "2026-10-26T12:00:00.000Z"),
            TestData.documentObject("cccccc", taskId: "tttttt", updatedAt: "2026-10-26T10:00:00.000Z"),
            TestData.documentObject("dddddd", taskId: "uuuuuu", updatedAt: "2026-10-26T11:00:00.000Z"),
        ])
        XCTAssertEqual(catalog.documents(taskId: "tttttt").map(\.id), ["cccccc", "aaaaaa"])
        XCTAssertEqual(catalog.documents(taskId: "uuuuuu").map(\.id), ["dddddd"])
        XCTAssertEqual(catalog.documents(taskId: "zzzzzz"), [])
    }

    // MARK: annotation.updated events

    func testAnnotationsAreKeptPerDocumentNewestCreatedFirst() throws {
        var catalog = try catalog([TestData.documentObject("aaaaaa"), TestData.documentObject("bbbbbb")])
        let events = [
            TestData.annotationEvent(1, annotation: TestData.annotationObject("g7e4xr", documentId: "aaaaaa", createdAt: "2026-10-27T01:00:00.000Z")),
            TestData.annotationEvent(2, annotation: TestData.annotationObject("k6p3dh", documentId: "aaaaaa", createdAt: "2026-10-27T02:00:00.000Z")),
            TestData.annotationEvent(3, annotation: TestData.annotationObject("m5t8bq", documentId: "bbbbbb")),
        ]
        for event in events {
            catalog.apply(try TestData.streamEvent(event))
        }
        XCTAssertEqual(catalog.annotations(of: "aaaaaa").map(\.id), ["k6p3dh", "g7e4xr"])
        XCTAssertEqual(catalog.annotations(of: "bbbbbb").map(\.id), ["m5t8bq"])
        XCTAssertEqual(catalog.annotations(of: "zzzzzz"), [])
    }

    func testAnAnnotationTakesItsLatestVersion() throws {
        var catalog = DocumentCatalog()
        let resolved = TestData.annotationObject("g7e4xr", documentId: "aaaaaa", state: "resolved", updatedAt: "2026-10-27T03:00:00.000Z")
        let submitted = TestData.annotationObject("g7e4xr", documentId: "aaaaaa", state: "submitted", updatedAt: "2026-10-27T01:00:00.000Z")
        catalog.apply(try TestData.streamEvent(TestData.annotationEvent(2, annotation: resolved)))
        catalog.apply(try TestData.streamEvent(TestData.annotationEvent(1, annotation: submitted)))
        XCTAssertEqual(catalog.annotations(of: "aaaaaa").map(\.state), [.resolved], "a replayed event must not undo a newer version")
    }

    func testAnAnnotationDoesNotAddADocument() throws {
        var catalog = DocumentCatalog()
        catalog.apply(try TestData.streamEvent(TestData.annotationEvent(1, annotation: TestData.annotationObject("g7e4xr", documentId: "aaaaaa"))))
        XCTAssertEqual(catalog.documents, [])
    }
}
