import Foundation

/// What an annotation is on: a passage of the text, anchored by its quote and the text on each side of it, or the whole document.
/// It codes as an object whose `kind` is `passage` or `document`. Any other kind does not decode.
public enum AnnotationTarget: Hashable, Sendable, Codable {
    case passage(quote: String, prefix: String, suffix: String)
    case document

    private enum CodingKeys: String, CodingKey {
        case kind, quote, prefix, suffix
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let kind = try container.decode(String.self, forKey: .kind)
        switch kind {
        case "passage":
            self = .passage(
                quote: try container.decode(String.self, forKey: .quote),
                prefix: try container.decode(String.self, forKey: .prefix),
                suffix: try container.decode(String.self, forKey: .suffix)
            )
        case "document":
            self = .document
        default:
            throw DecodingError.dataCorruptedError(
                forKey: .kind,
                in: container,
                debugDescription: "unknown annotation target \(kind)"
            )
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .passage(quote, prefix, suffix):
            try container.encode("passage", forKey: .kind)
            try container.encode(quote, forKey: .quote)
            try container.encode(prefix, forKey: .prefix)
            try container.encode(suffix, forKey: .suffix)
        case .document:
            try container.encode("document", forKey: .kind)
        }
    }
}

/// An annotation: the owner's comment on a passage or on the whole document, and how its revision run stands with it.
public struct Annotation: Decodable, Identifiable, Hashable, Sendable {
    public let id: String
    public let documentId: String
    /// The version the owner annotated.
    public let version: String
    public let target: AnnotationTarget
    public let comment: String
    public let state: AnnotationState
    /// The revision run that took the annotation.
    public let runId: String
    /// Alfred's answer. Set when resolved, and kept on a returned annotation that was answered before an undo.
    public let reply: String?
    /// Why the annotation went back to the owner. Set exactly when returned.
    public let returnReason: AnnotationReturnReason?
    public let createdAt: Date
    public let updatedAt: Date

    private enum CodingKeys: String, CodingKey {
        case id, documentId, version, target, comment, state, runId, reply, returnReason, createdAt, updatedAt
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        documentId = try container.decode(String.self, forKey: .documentId)
        version = try container.decode(String.self, forKey: .version)
        target = try container.decode(AnnotationTarget.self, forKey: .target)
        comment = try container.decode(String.self, forKey: .comment)
        state = try container.decode(AnnotationState.self, forKey: .state)
        runId = try container.decode(String.self, forKey: .runId)
        reply = try container.decodeIfPresent(String.self, forKey: .reply)
        returnReason = try container.decodeIfPresent(AnnotationReturnReason.self, forKey: .returnReason)
        createdAt = try container.decodeTimestamp(forKey: .createdAt)
        updatedAt = try container.decodeTimestamp(forKey: .updatedAt)
    }
}

/// One annotation of a revision batch: what `document.revise` sends. A batch holds one to fifty.
public struct AnnotationDraft: Codable, Hashable, Sendable {
    public let target: AnnotationTarget
    public let comment: String

    public init(target: AnnotationTarget, comment: String) {
        self.target = target
        self.comment = comment
    }
}
