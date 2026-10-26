import AlfredKit
import Foundation
import Observation

/// A comment the owner wrote on a document and has not submitted: on a passage, or on the whole document. It waits on
/// the phone until a batch of drafts is submitted as one revision, or until it is deleted.
struct StoredDraft: Codable, Hashable, Identifiable, Sendable {
    let id: String
    let documentId: String
    /// The version the draft was written on. While the draft fits the document's current version this follows it, so it
    /// says which version the target's quote and context were taken from.
    var version: String
    var target: AnnotationTarget
    var comment: String
    /// The returned annotation this draft was made from by 重新编辑, when there is one.
    var origin: String?

    init(
        id: String = UUID().uuidString.lowercased(),
        documentId: String,
        version: String,
        target: AnnotationTarget,
        comment: String,
        origin: String? = nil
    ) {
        self.id = id
        self.documentId = documentId
        self.version = version
        self.target = target
        self.comment = comment
        self.origin = origin
    }
}

/// The drafts, in the order they were written. A batch is sent in that order.
struct DraftList: Equatable {
    /// The most annotations one revision takes (Alfred's limit).
    static let maxBatch = 50

    private(set) var items: [StoredDraft] = []

    /// The drafts of one document, in the order they were written.
    func drafts(of documentId: String) -> [StoredDraft] {
        items.filter { $0.documentId == documentId }
    }

    func draft(id: String) -> StoredDraft? {
        items.first { $0.id == id }
    }

    mutating func add(_ draft: StoredDraft) {
        items.append(draft)
    }

    mutating func setComment(_ comment: String, of id: String) {
        guard let index = items.firstIndex(where: { $0.id == id }) else { return }
        items[index].comment = comment
    }

    /// A draft that no longer fits becomes a comment on the whole document, written on `version`.
    mutating func makeWholeDocument(_ id: String, version: String) {
        guard let index = items.firstIndex(where: { $0.id == id }) else { return }
        items[index].target = .document
        items[index].version = version
    }

    mutating func remove(ids: Set<String>) {
        items.removeAll { ids.contains($0.id) }
    }

    /// Brings the drafts of a document that were written on another version to `version`, whose text is `text` (`nil`
    /// when it is not known, or the document has no text to anchor on). A whole-document comment fits any version. A
    /// passage that fits `text` takes the context it has there; one that does not stays as it was, on the version it
    /// was written on. Returns whether anything changed.
    @discardableResult
    mutating func reanchor(documentId: String, to version: String, in text: AnchorText?) -> Bool {
        var changed = false
        for index in items.indices where items[index].documentId == documentId && items[index].version != version {
            switch items[index].target {
            case .document:
                items[index].version = version
                changed = true
            case .passage:
                guard let text, let target = text.reanchored(items[index].target) else { continue }
                items[index].target = target
                items[index].version = version
                changed = true
            }
        }
        return changed
    }

    /// The drafts of a document that will go in a batch on a version whose text is `text`, in the order they were
    /// written, each with the target it has on that text: a whole-document comment always, a passage when it fits.
    /// The first `maxBatch` of them.
    func batch(documentId: String, in text: AnchorText?) -> [StoredDraft] {
        var batch: [StoredDraft] = []
        for draft in drafts(of: documentId) {
            switch draft.target {
            case .document:
                batch.append(draft)
            case .passage:
                guard let text, let target = text.reanchored(draft.target) else { continue }
                var sent = draft
                sent.target = target
                batch.append(sent)
            }
            if batch.count == Self.maxBatch { break }
        }
        return batch
    }
}

/// The drafts' file in Application Support, written atomically.
struct DraftFile {
    private struct Contents: Codable {
        var version = 1
        var drafts: [StoredDraft]
    }

    let url: URL

    /// The app's file: `Alfred/annotation-drafts.json` in Application Support.
    static var standard: DraftFile? {
        guard let support = try? FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true) else {
            return nil
        }
        return DraftFile(url: support.appending(path: "Alfred", directoryHint: .isDirectory).appending(path: "annotation-drafts.json"))
    }

    /// The saved drafts. A missing file, or one that cannot be read, holds none.
    func load() -> DraftList {
        guard let data = try? Data(contentsOf: url), let contents = try? Self.decoder.decode(Contents.self, from: data) else {
            return DraftList()
        }
        var list = DraftList()
        for draft in contents.drafts {
            list.add(draft)
        }
        return list
    }

    func save(_ list: DraftList) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let data = try Self.encoder.encode(Contents(drafts: list.items))
        try data.write(to: url, options: .atomic)
    }

    func delete() {
        try? FileManager.default.removeItem(at: url)
    }

    private static let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .prettyPrinted]
        return encoder
    }()

    private static let decoder = JSONDecoder()
}

/// The drafts the app holds, and the file that keeps them. Every change is written at once; a draft survives a
/// relaunch until it is submitted or deleted. Without a file (a model made for a test) they are only in memory.
@MainActor
@Observable
final class DraftStore {
    private(set) var list: DraftList
    /// Whether the last write to the file failed.
    private(set) var saveFailed = false
    @ObservationIgnored private let file: DraftFile?

    init(file: DraftFile? = nil) {
        self.file = file
        list = file?.load() ?? DraftList()
    }

    func drafts(of documentId: String) -> [StoredDraft] {
        list.drafts(of: documentId)
    }

    @discardableResult
    func add(documentId: String, version: String, target: AnnotationTarget, comment: String, origin: String? = nil) -> StoredDraft {
        let draft = StoredDraft(documentId: documentId, version: version, target: target, comment: comment, origin: origin)
        change { $0.add(draft) }
        return draft
    }

    func setComment(_ comment: String, of id: String) {
        change { $0.setComment(comment, of: id) }
    }

    func makeWholeDocument(_ id: String, version: String) {
        change { $0.makeWholeDocument(id, version: version) }
    }

    func remove(ids: Set<String>) {
        change { $0.remove(ids: ids) }
    }

    func reanchor(documentId: String, to version: String, in text: AnchorText?) {
        var next = list
        guard next.reanchor(documentId: documentId, to: version, in: text) else { return }
        change { $0 = next }
    }

    /// Forgets every draft and deletes the file: the pairing is gone.
    func clear() {
        list = DraftList()
        saveFailed = false
        file?.delete()
    }

    private func change(_ edit: (inout DraftList) -> Void) {
        edit(&list)
        guard let file else { return }
        do {
            try file.save(list)
            saveFailed = false
        } catch {
            saveFailed = true
        }
    }
}

/// What came of submitting a document's drafts.
enum AnnotationSubmission: Equatable {
    /// No draft would go: there are none, or none fits.
    case nothingToSend
    /// 202: the revision run, and the annotations Alfred recorded for the batch.
    case accepted(runId: String, annotations: [Annotation])
    /// 409: the server's message, and the document's detail read again when that worked. The drafts stay.
    case conflict(message: String, detail: DocumentDetail?)
    /// Any other refusal, with the server's message. The drafts stay.
    case rejected(message: String)
    /// The request did not get an answer. The drafts stay.
    case failed(message: String)

    /// The message to show, when the submission did not work.
    var failureMessage: String? {
        switch self {
        case let .conflict(message, _), let .rejected(message), let .failed(message): message
        case .nothingToSend, .accepted: nil
        }
    }
}

/// What came of undoing a revision.
enum UndoOutcome: Equatable {
    case undone(AlfredDocument)
    /// The server's message (409 when other runs have changed the files since), or the usual words.
    case refused(String)
}
