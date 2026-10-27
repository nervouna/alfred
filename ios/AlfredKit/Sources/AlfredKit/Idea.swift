import Foundation

/// Why the owner rejected an idea, and the note they gave, if any.
public struct Rejection: Decodable, Hashable, Sendable {
    public let reason: RejectionReason
    public let note: String?
}

/// An idea: a suggestion Alfred made from memory and recent conversations. Alfred's idea object, with every field the client shows.
public struct AlfredIdea: Decodable, Identifiable, Hashable, Sendable {
    public let id: String
    /// Becomes the task's title when the idea is accepted.
    public let title: String
    /// One line on why Alfred suggests the idea.
    public let why: String
    /// Becomes the task's brief when the idea is accepted.
    public let brief: String
    public let kind: IdeaKind
    /// The schedule a recurring idea proposes. Set exactly when the kind is recurring.
    public let schedule: Schedule?
    /// The model the idea proposes for its task.
    public let model: TaskModel
    /// The estimated cost of one run, in USD.
    public let estimateUsd: Double
    public let state: IdeaState
    /// The task the accepted idea became. Set exactly when accepted.
    public let taskId: String?
    /// Why the owner rejected the idea. Set exactly when rejected.
    public let rejection: Rejection?
    /// The generation run that made the idea.
    public let runId: String
    public let createdAt: Date
    public let updatedAt: Date

    private enum CodingKeys: String, CodingKey {
        case id, title, why, brief, kind, schedule, model, estimateUsd, state, taskId, rejection, runId, createdAt, updatedAt
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        title = try container.decode(String.self, forKey: .title)
        why = try container.decode(String.self, forKey: .why)
        brief = try container.decode(String.self, forKey: .brief)
        kind = try container.decode(IdeaKind.self, forKey: .kind)
        schedule = try container.decodeIfPresent(Schedule.self, forKey: .schedule)
        model = try container.decode(TaskModel.self, forKey: .model)
        estimateUsd = try container.decode(Double.self, forKey: .estimateUsd)
        state = try container.decode(IdeaState.self, forKey: .state)
        taskId = try container.decodeIfPresent(String.self, forKey: .taskId)
        rejection = try container.decodeIfPresent(Rejection.self, forKey: .rejection)
        runId = try container.decode(String.self, forKey: .runId)
        createdAt = try container.decodeTimestamp(forKey: .createdAt)
        updatedAt = try container.decodeTimestamp(forKey: .updatedAt)
    }
}
