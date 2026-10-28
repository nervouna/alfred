import Foundation

/// One event from Alfred's stream. A `type` the client does not know decodes to `.unknown`,
/// and fields it does not know are ignored.
public struct Event: Decodable, Hashable, Sendable {
    public enum Payload: Hashable, Sendable {
        case messageCreated(Message)
        case runUpdated(Run)
        /// Alfred asks the owner something and the run waits.
        case questionAsked(QuestionAsked)
        /// The question was answered, or cancelled.
        case questionAnswered(QuestionAnswered)
        /// A task was created or changed: the whole task, as Alfred now holds it.
        case taskUpdated(AlfredTask)
        /// A document was delivered or changed: the whole document, as Alfred now holds it.
        case documentUpdated(AlfredDocument)
        /// A document was deleted (moved into the agent's trash): the id of the document. Moving it back out announces
        /// it again as `documentUpdated`.
        case documentRemoved(id: String)
        /// An annotation was submitted or changed: the whole annotation, as Alfred now holds it.
        case annotationUpdated(Annotation)
        /// An idea was generated or changed state: the whole idea, as Alfred now holds it.
        case ideaUpdated(AlfredIdea)
        /// An event type this client does not know. Its `data` is not decoded.
        case unknown(type: String)
    }

    public let id: Int64
    public let at: Date
    public let payload: Payload

    private enum CodingKeys: String, CodingKey {
        case id, at, type, data
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(Int64.self, forKey: .id)
        at = try container.decodeTimestamp(forKey: .at)
        let type = try container.decode(String.self, forKey: .type)
        switch type {
        case "message.created":
            payload = .messageCreated(try container.decode(Message.self, forKey: .data))
        case "run.updated":
            payload = .runUpdated(try container.decode(Run.self, forKey: .data))
        case "question.asked":
            payload = .questionAsked(try container.decode(QuestionAsked.self, forKey: .data))
        case "question.answered":
            payload = .questionAnswered(try container.decode(QuestionAnswered.self, forKey: .data))
        case "task.updated":
            payload = .taskUpdated(try container.decode(AlfredTask.self, forKey: .data))
        case "document.updated":
            payload = .documentUpdated(try container.decode(AlfredDocument.self, forKey: .data))
        case "document.removed":
            payload = .documentRemoved(id: try container.decode(DocumentRemoved.self, forKey: .data).id)
        case "annotation.updated":
            payload = .annotationUpdated(try container.decode(Annotation.self, forKey: .data))
        case "idea.updated":
            payload = .ideaUpdated(try container.decode(AlfredIdea.self, forKey: .data))
        default:
            payload = .unknown(type: type)
        }
    }

    /// The data of a `document.removed` event.
    private struct DocumentRemoved: Decodable {
        let id: String
    }
}
