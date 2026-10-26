import Foundation

/// A file attached to a message, relative to the workspace.
public struct FileRef: Codable, Hashable, Sendable {
    public let path: String
    public let kind: FileKind?
}

/// A message between the owner and Alfred, on either channel.
public struct Message: Decodable, Hashable, Sendable {
    /// `in` for what the owner sent, `out` for what Alfred sent.
    public struct Direction: ExtensibleString {
        public let rawValue: String

        public init(rawValue: String) {
            self.rawValue = rawValue
        }

        public static let inbound = Direction(rawValue: "in")
        public static let outbound = Direction(rawValue: "out")
    }

    public let id: String
    public let channel: Channel
    public let direction: Direction
    public let text: String
    public let files: [FileRef]
    public let at: Date
    public let runId: String?
    /// Set on a message a task's run delivered.
    public let taskId: String?
    public let clientId: String?
    public let error: String?

    private enum CodingKeys: String, CodingKey {
        case id, channel, direction, text, files, at, runId, taskId, clientId, error
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        channel = try container.decode(Channel.self, forKey: .channel)
        direction = try container.decode(Direction.self, forKey: .direction)
        text = try container.decode(String.self, forKey: .text)
        files = try container.decode([FileRef].self, forKey: .files)
        at = try container.decodeTimestamp(forKey: .at)
        runId = try container.decodeIfPresent(String.self, forKey: .runId)
        taskId = try container.decodeIfPresent(String.self, forKey: .taskId)
        clientId = try container.decodeIfPresent(String.self, forKey: .clientId)
        error = try container.decodeIfPresent(String.self, forKey: .error)
    }
}
