import AlfredKit
import XCTest

@testable import Alfred

/// The drafts the owner writes: kept on the phone in a file, edited, deleted, anchored again on a newer version, and
/// forgotten when the app is unpaired.
@MainActor
final class StoredDraftTests: XCTestCase {
    private let v1 = TestData.commit(1)
    private let v2 = TestData.commit(2)

    /// A file in a folder of its own, as the app's is in Application Support.
    private func makeFile() throws -> DraftFile {
        let folder = FileManager.default.temporaryDirectory.appending(path: "drafts-" + UUID().uuidString, directoryHint: .isDirectory)
        addTeardownBlock { try? FileManager.default.removeItem(at: folder) }
        return DraftFile(url: folder.appending(path: "Alfred", directoryHint: .isDirectory).appending(path: "annotation-drafts.json"))
    }

    private func passage(_ quote: String, prefix: String = "", suffix: String = "") -> AnnotationTarget {
        .passage(quote: quote, prefix: prefix, suffix: suffix)
    }

    // MARK: Storage

    func testADraftIsSavedAtOnceAndSurvivesAReload() throws {
        let file = try makeFile()
        let store = DraftStore(file: file)
        let draft = store.add(documentId: "aaaaaa", version: v1, target: passage("进口量", prefix: "上涨，", suffix: "明显"), comment: "写具体")
        store.add(documentId: "aaaaaa", version: v1, target: .document, comment: "整篇再正式些")

        XCTAssertTrue(FileManager.default.fileExists(atPath: file.url.path))
        let reloaded = DraftStore(file: file)
        XCTAssertEqual(reloaded.list, store.list)
        XCTAssertEqual(reloaded.drafts(of: "aaaaaa").map(\.comment), ["写具体", "整篇再正式些"], "in the order they were written")
        XCTAssertEqual(reloaded.list.draft(id: draft.id)?.target, passage("进口量", prefix: "上涨，", suffix: "明显"))
        XCTAssertEqual(reloaded.list.draft(id: draft.id)?.version, v1)
        XCTAssertFalse(store.saveFailed)
    }

    func testAnEditedCommentAndADeletedDraftAreSavedToo() throws {
        let file = try makeFile()
        let store = DraftStore(file: file)
        let first = store.add(documentId: "aaaaaa", version: v1, target: .document, comment: "旧的话")
        let second = store.add(documentId: "aaaaaa", version: v1, target: .document, comment: "另一条")

        store.setComment("新的话", of: first.id)
        XCTAssertEqual(DraftStore(file: file).drafts(of: "aaaaaa").map(\.comment), ["新的话", "另一条"], "the edit keeps the draft's place")

        store.remove(ids: [first.id])
        XCTAssertEqual(DraftStore(file: file).drafts(of: "aaaaaa").map(\.id), [second.id])
    }

    func testDraftsAreKeptPerDocument() throws {
        let store = DraftStore(file: try makeFile())
        store.add(documentId: "aaaaaa", version: v1, target: .document, comment: "甲")
        store.add(documentId: "bbbbbb", version: v1, target: .document, comment: "乙")

        XCTAssertEqual(store.drafts(of: "aaaaaa").map(\.comment), ["甲"])
        XCTAssertEqual(store.drafts(of: "bbbbbb").map(\.comment), ["乙"])
        XCTAssertEqual(store.drafts(of: "cccccc"), [])
    }

    func testClearingForgetsTheDraftsAndDeletesTheFile() throws {
        let file = try makeFile()
        let store = DraftStore(file: file)
        store.add(documentId: "aaaaaa", version: v1, target: .document, comment: "甲")

        store.clear()

        XCTAssertEqual(store.list, DraftList())
        XCTAssertFalse(FileManager.default.fileExists(atPath: file.url.path))
        XCTAssertEqual(DraftStore(file: file).list, DraftList())
    }

    func testAFileThatCannotBeReadHoldsNoDrafts() throws {
        let file = try makeFile()
        try FileManager.default.createDirectory(at: file.url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("not json".utf8).write(to: file.url)

        let store = DraftStore(file: file)
        XCTAssertEqual(store.list, DraftList())
        store.add(documentId: "aaaaaa", version: v1, target: .document, comment: "甲")
        XCTAssertEqual(DraftStore(file: file).drafts(of: "aaaaaa").count, 1, "the next save replaces the unreadable file")
    }

    func testTheFileIsWrittenAtomically() throws {
        let file = try makeFile()
        let store = DraftStore(file: file)
        store.add(documentId: "aaaaaa", version: v1, target: .document, comment: "甲")
        store.add(documentId: "aaaaaa", version: v1, target: .document, comment: "乙")

        // An atomic write goes through a temporary file that is renamed over the old one: nothing else is left in the folder.
        let names = try FileManager.default.contentsOfDirectory(atPath: file.url.deletingLastPathComponent().path)
        XCTAssertEqual(names, ["annotation-drafts.json"])
    }

    func testAModelWithoutAFileKeepsDraftsInMemory() {
        let store = DraftStore()
        store.add(documentId: "aaaaaa", version: v1, target: .document, comment: "甲")

        XCTAssertEqual(store.drafts(of: "aaaaaa").count, 1)
        XCTAssertFalse(store.saveFailed)
    }

    func testAFailedWriteIsReported() throws {
        let folder = FileManager.default.temporaryDirectory.appending(path: "drafts-" + UUID().uuidString, directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: folder) }
        // A file stands where the folder of the drafts file should be.
        let blocker = folder.appending(path: "Alfred")
        try Data().write(to: blocker)
        let store = DraftStore(file: DraftFile(url: blocker.appending(path: "annotation-drafts.json")))

        store.add(documentId: "aaaaaa", version: v1, target: .document, comment: "甲")

        XCTAssertTrue(store.saveFailed)
        XCTAssertEqual(store.drafts(of: "aaaaaa").count, 1, "the draft is still there, in memory")
    }

    // MARK: Unpairing

    func testUnpairingClearsTheDraftsAndTheFile() async throws {
        let file = try makeFile()
        let server = StubServer { request in
            request.url?.path == "/api/events" ? .stream() : StubReply(status: 404)
        }
        let model = AppModel(store: InMemoryCredentialStore(try server.credentials()), session: server.session, draftFile: file)
        addTeardownBlock { @MainActor in withExtendedLifetime(server) {} }
        model.annotationDrafts.add(documentId: "aaaaaa", version: v1, target: .document, comment: "甲")
        XCTAssertTrue(FileManager.default.fileExists(atPath: file.url.path))

        model.unpair()

        XCTAssertEqual(model.annotationDrafts.list, DraftList())
        XCTAssertFalse(FileManager.default.fileExists(atPath: file.url.path))
    }

    func testAModelStartsWithTheDraftsOfTheLastRun() throws {
        let file = try makeFile()
        let server = StubServer { _ in StubReply(status: 404) }
        addTeardownBlock { @MainActor in withExtendedLifetime(server) {} }
        let first = AppModel(store: InMemoryCredentialStore(try server.credentials()), session: server.session, draftFile: file)
        first.annotationDrafts.add(documentId: "aaaaaa", version: v1, target: passage("进口量"), comment: "甲")

        let second = AppModel(store: InMemoryCredentialStore(try server.credentials()), session: server.session, draftFile: file)

        XCTAssertEqual(second.annotationDrafts.drafts(of: "aaaaaa").map(\.comment), ["甲"])
    }

    // MARK: Anchoring again

    func testADraftOnAnOlderVersionTakesTheContextOfTheCurrentOne() {
        var list = DraftList()
        list.add(StoredDraft(id: "d1", documentId: "aaaaaa", version: v1, target: passage("苹果", prefix: "旧的开头。", suffix: "很甜。"), comment: "甲"))
        let current = AnchorText(text: "新的开头，苹果很甜。新的结尾。")

        let changed = list.reanchor(documentId: "aaaaaa", to: v2, in: current)

        XCTAssertTrue(changed)
        let draft = list.draft(id: "d1")
        XCTAssertEqual(draft?.version, v2)
        XCTAssertEqual(draft?.target, passage("苹果", prefix: "新的开头，", suffix: "很甜。新的结尾。"))
    }

    func testADraftThatDoesNotFitStaysAsItWasOnTheVersionItWasWrittenOn() {
        var list = DraftList()
        let target = passage("苹果", prefix: "旧的开头。", suffix: "很甜。")
        list.add(StoredDraft(id: "d1", documentId: "aaaaaa", version: v1, target: target, comment: "甲"))

        let changed = list.reanchor(documentId: "aaaaaa", to: v2, in: AnchorText(text: "整段都改了"))

        XCTAssertFalse(changed)
        XCTAssertEqual(list.draft(id: "d1")?.version, v1)
        XCTAssertEqual(list.draft(id: "d1")?.target, target)
    }

    func testAWholeDocumentCommentFitsAnyVersionAndNeedsNoText() {
        var list = DraftList()
        list.add(StoredDraft(id: "d1", documentId: "aaaaaa", version: v1, target: .document, comment: "甲"))

        XCTAssertTrue(list.reanchor(documentId: "aaaaaa", to: v2, in: nil))

        XCTAssertEqual(list.draft(id: "d1")?.version, v2)
    }

    func testAPassageWaitsWhenTheTextIsNotKnown() {
        var list = DraftList()
        list.add(StoredDraft(id: "d1", documentId: "aaaaaa", version: v1, target: passage("苹果"), comment: "甲"))

        XCTAssertFalse(list.reanchor(documentId: "aaaaaa", to: v2, in: nil))
        XCTAssertEqual(list.draft(id: "d1")?.version, v1)
    }

    func testDraftsOfOtherDocumentsAndOfTheCurrentVersionAreLeftAlone() {
        var list = DraftList()
        list.add(StoredDraft(id: "other", documentId: "bbbbbb", version: v1, target: .document, comment: "乙"))
        list.add(StoredDraft(id: "current", documentId: "aaaaaa", version: v2, target: passage("苹果", prefix: "旧"), comment: "甲"))

        XCTAssertFalse(list.reanchor(documentId: "aaaaaa", to: v2, in: AnchorText(text: "新苹果")))

        XCTAssertEqual(list.draft(id: "other")?.version, v1)
        XCTAssertEqual(list.draft(id: "current")?.target, passage("苹果", prefix: "旧"), "a draft already on the version keeps its target")
    }

    func testTheStoreWritesWhatAnchoringChanged() throws {
        let file = try makeFile()
        let store = DraftStore(file: file)
        store.add(documentId: "aaaaaa", version: v1, target: .document, comment: "甲")

        store.reanchor(documentId: "aaaaaa", to: v2, in: nil)

        XCTAssertEqual(DraftStore(file: file).drafts(of: "aaaaaa").first?.version, v2)
    }

    func testAMismatchedDraftBecomesAWholeDocumentComment() {
        var list = DraftList()
        list.add(StoredDraft(id: "d1", documentId: "aaaaaa", version: v1, target: passage("苹果"), comment: "甲"))

        list.makeWholeDocument("d1", version: v2)

        XCTAssertEqual(list.draft(id: "d1")?.target, .document)
        XCTAssertEqual(list.draft(id: "d1")?.version, v2)
        XCTAssertEqual(list.draft(id: "d1")?.comment, "甲")
    }

    // MARK: The batch

    func testTheBatchIsTheDraftsThatFitInTheOrderTheyWereWritten() {
        var list = DraftList()
        list.add(StoredDraft(id: "d1", documentId: "aaaaaa", version: v2, target: passage("苹果", prefix: "旧"), comment: "一"))
        list.add(StoredDraft(id: "d2", documentId: "aaaaaa", version: v2, target: passage("不在文里"), comment: "二"))
        list.add(StoredDraft(id: "d3", documentId: "aaaaaa", version: v2, target: .document, comment: "三"))
        list.add(StoredDraft(id: "d4", documentId: "bbbbbb", version: v2, target: .document, comment: "四"))
        let text = AnchorText(text: "有苹果和梨")

        let batch = list.batch(documentId: "aaaaaa", in: text)

        XCTAssertEqual(batch.map(\.id), ["d1", "d3"])
        XCTAssertEqual(batch.first?.target, passage("苹果", prefix: "有", suffix: "和梨"), "a passage goes with the context it has in the text")
        XCTAssertEqual(list.batch(documentId: "aaaaaa", in: nil).map(\.id), ["d3"], "without the text only the whole-document comments go")
    }

    func testTheBatchHoldsAtMostFiftyDrafts() {
        var list = DraftList()
        for number in 1...60 {
            list.add(StoredDraft(documentId: "aaaaaa", version: v1, target: .document, comment: "第 \(number) 条"))
        }

        let batch = list.batch(documentId: "aaaaaa", in: nil)

        XCTAssertEqual(batch.count, 50)
        XCTAssertEqual(batch.first?.comment, "第 1 条")
        XCTAssertEqual(batch.last?.comment, "第 50 条")
    }
}
