/// A command the client sends to Alfred. Alfred validates it; this type only shapes the JSON.
public enum Command: Hashable, Sendable, Codable {
    /// `files` are inbox paths the owner attached. `text` is empty only when `files` is not.
    case messageSend(clientId: String, text: String, files: [FileRef] = [])
    case runStop(runId: String)
    /// Answers an open question. `answers` maps a question's text to its answer: an option's label, the labels of
    /// several joined with `, ` for a multi-select question, or free text of 1 to 2000 characters.
    case questionAnswer(questionId: String, answers: [String: String])

    private enum CodingKeys: String, CodingKey {
        case type, clientId, text, runId, files, questionId, answers
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
        case "question.answer":
            self = .questionAnswer(
                questionId: try container.decode(String.self, forKey: .questionId),
                answers: try container.decode([String: String].self, forKey: .answers)
            )
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
        case let .questionAnswer(questionId, answers):
            try container.encode("question.answer", forKey: .type)
            try container.encode(questionId, forKey: .questionId)
            try container.encode(answers, forKey: .answers)
        }
    }
}
