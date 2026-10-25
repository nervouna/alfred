import Foundation

/// One event from Alfred's stream. A `type` the client does not know decodes to `.unknown`,
/// and fields it does not know are ignored.
public struct Event: Decodable, Hashable, Sendable {
    public enum Payload: Hashable, Sendable {
        case messageCreated(Message)
        case runUpdated(Run)
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
        default:
            payload = .unknown(type: type)
        }
    }
}
