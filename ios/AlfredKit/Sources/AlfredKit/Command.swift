/// A command the client sends to Alfred. Alfred validates it; this type only shapes the JSON.
public enum Command: Hashable, Sendable, Codable {
    /// `files` are inbox paths the owner attached. `text` is empty only when `files` is not.
    case messageSend(clientId: String, text: String, files: [FileRef] = [])
    case runStop(runId: String)

    private enum CodingKeys: String, CodingKey {
        case type, clientId, text, runId, files
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = try container.decode(String.self, forKey: .type)
        switch type {
        case "message.send":
            self = .messageSend(
                clientId: try container.decode(String.self, forKey: .clientId),
                text: try container.decode(String.self, forKey: .text),
                files: try container.decodeIfPresent([FileRef].self, forKey: .files) ?? []
            )
        case "run.stop":
            self = .runStop(runId: try container.decode(String.self, forKey: .runId))
        default:
            throw DecodingError.dataCorruptedError(
                forKey: .type,
                in: container,
                debugDescription: "unknown command \(type)"
            )
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .messageSend(clientId, text, files):
            try container.encode("message.send", forKey: .type)
            try container.encode(clientId, forKey: .clientId)
            try container.encode(text, forKey: .text)
            if !files.isEmpty {
                try container.encode(files, forKey: .files)
            }
        case let .runStop(runId):
            try container.encode("run.stop", forKey: .type)
            try container.encode(runId, forKey: .runId)
        }
    }
}
