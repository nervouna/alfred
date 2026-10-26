import AlfredKit
import Foundation

/// The owner's documents as the app knows them: the list `GET /api/documents` returned, and every `document.updated`
/// event since. Each document takes its latest version by `updatedAt`, so a list that was read before a change cannot
/// undo it, and a replayed event cannot either. A document is never removed: Alfred has no way to delete one. The
/// annotations `annotation.updated` events told of are kept per document, for the screens that come to show them.
struct DocumentCatalog: Hashable {
    /// Whether a list has been read.
    private(set) var hasLoaded = false
    private var byId: [String: AlfredDocument] = [:]
    /// Each document's annotations by id, each in its latest version.
    private var annotationsByDocument: [String: [String: Annotation]] = [:]

    /// Merges a list the server returned.
    mutating func load(_ list: DocumentList) {
        hasLoaded = true
        for document in list.documents {
            apply(document)
        }
    }

    /// A stored `document.updated` event changes its document, and an `annotation.updated` event its annotation; any
    /// other event changes nothing.
    mutating func apply(_ event: StreamEvent) {
        guard case let .event(stored) = event else { return }
        switch stored.payload {
        case let .documentUpdated(document): apply(document)
        case let .annotationUpdated(annotation): apply(annotation)
        default: break
        }
    }

    /// Takes a document unless the catalog already holds a newer version of it.
    mutating func apply(_ document: AlfredDocument) {
        if let known = byId[document.id], known.updatedAt > document.updatedAt { return }
        byId[document.id] = document
    }

    /// Takes an annotation unless the catalog already holds a newer version of it.
    mutating func apply(_ annotation: Annotation) {
        if let known = annotationsByDocument[annotation.documentId]?[annotation.id], known.updatedAt > annotation.updatedAt { return }
        annotationsByDocument[annotation.documentId, default: [:]][annotation.id] = annotation
    }

    func document(id: String) -> AlfredDocument? {
        byId[id]
    }

    /// The documents, most recently updated first.
    var documents: [AlfredDocument] {
        ordered(byId.values)
    }

    /// The documents a task's runs delivered, most recently updated first.
    func documents(taskId: String) -> [AlfredDocument] {
        ordered(byId.values.filter { $0.taskId == taskId })
    }

    /// The annotations of a document the stream has told of, newest created first.
    func annotations(of documentId: String) -> [Annotation] {
        (annotationsByDocument[documentId] ?? [:]).values.sorted { first, second in
            first.createdAt != second.createdAt ? first.createdAt > second.createdAt : first.id < second.id
        }
    }

    private func ordered(_ documents: some Sequence<AlfredDocument>) -> [AlfredDocument] {
        documents.sorted { first, second in
            first.updatedAt != second.updatedAt ? first.updatedAt > second.updatedAt : first.id < second.id
        }
    }
}
