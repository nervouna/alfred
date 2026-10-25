/// One choice of a question.
public struct QuestionOption: Decodable, Hashable, Sendable {
    public let label: String
    public let description: String

    public init(label: String, description: String) {
        self.label = label
        self.description = description
    }
}

/// One question Alfred asks the owner mid-run: two to four options, of which one or, when `multiSelect`, several may be picked.
public struct Question: Decodable, Hashable, Sendable {
    /// The question's text. An answer is keyed by it.
    public let question: String
    /// A very short label for the question.
    public let header: String
    public let options: [QuestionOption]
    public let multiSelect: Bool
}

/// A run waiting for the owner: the `question.asked` event. It stays open until a `question.answered` event with its `id`.
public struct QuestionAsked: Decodable, Hashable, Sendable {
    public let id: String
    public let runId: String
    /// One to four questions, answered together.
    public let questions: [Question]
}

/// The `question.answered` event: the owner answered, or the question was cancelled by a stop.
public struct QuestionAnswered: Decodable, Hashable, Sendable {
    public let id: String
    public let runId: String
    /// Each answer by its question's text: an option's label, the labels of several joined with `, ` for a
    /// multi-select question, or free text. Empty when `cancelled`.
    public let answers: [String: String]
    public let cancelled: Bool

    private enum CodingKeys: String, CodingKey {
        case id, runId, answers, cancelled
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        runId = try container.decode(String.self, forKey: .runId)
        answers = try container.decode([String: String].self, forKey: .answers)
        cancelled = try container.decodeIfPresent(Bool.self, forKey: .cancelled) ?? false
    }
}
