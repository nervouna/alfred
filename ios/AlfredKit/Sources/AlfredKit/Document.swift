import Foundation

/// A file Alfred delivered, known by its workspace path. Alfred's document object, with every field the client shows.
public struct AlfredDocument: Decodable, Identifiable, Hashable, Sendable {
    public let id: String
    /// Workspace-relative path.
    public let path: String
    public let title: String
    public let kind: DocumentKind
    /// Set when a task's run delivered the document.
    public let taskId: String?
    /// The document's current version: the full commit id.
    public let version: String
    public let createdAt: Date
    public let updatedAt: Date

    private enum CodingKeys: String, CodingKey {
        case id, path, title, kind, taskId, version, createdAt, updatedAt
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        path = try container.decode(String.self, forKey: .path)
        title = try container.decode(String.self, forKey: .title)
        kind = try container.decode(DocumentKind.self, forKey: .kind)
        taskId = try container.decodeIfPresent(String.self, forKey: .taskId)
        version = try container.decode(String.self, forKey: .version)
        createdAt = try container.decodeTimestamp(forKey: .createdAt)
        updatedAt = try container.decodeTimestamp(forKey: .updatedAt)
    }

    /// Whether the document is under `.trash/` at the root of the workspace, where the agent's deletions go. Alfred
    /// serves none of such a document (`isTrashedPath`, `src/documents/trash.ts`).
    public var isTrashed: Bool {
        path.hasPrefix(".trash/")
    }
}

/// One version of a document: a commit of the workspace, and what made it.
public struct DocumentVersion: Decodable, Hashable, Sendable {
    /// The full commit id.
    public let version: String
    public let at: Date
    public let reason: DocumentVersionReason
    /// The run that made the version. Absent on an undone version.
    public let runId: String?
    /// The revision run an undone version undid. Set exactly when the reason is undone.
    public let undoes: String?

    private enum CodingKeys: String, CodingKey {
        case version, at, reason, runId, undoes
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        version = try container.decode(String.self, forKey: .version)
        at = try container.decodeTimestamp(forKey: .at)
        reason = try container.decode(DocumentVersionReason.self, forKey: .reason)
        runId = try container.decodeIfPresent(String.self, forKey: .runId)
        undoes = try container.decodeIfPresent(String.self, forKey: .undoes)
    }
}
