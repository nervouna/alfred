import Foundation

/// A run a task did not run: when it was due, and why it did not run.
public struct TaskSkip: Decodable, Hashable, Sendable {
    /// Why a due run did not run.
    public struct Reason: ExtensibleString {
        public let rawValue: String

        public init(rawValue: String) {
            self.rawValue = rawValue
        }

        /// Alfred was not running in time, and the run was too old to catch up on.
        public static let missed = Reason(rawValue: "missed")
        /// The day's spend cap was reached.
        public static let dailyCap = Reason(rawValue: "daily-cap")
    }

    /// The scheduled time that was skipped.
    public let at: Date
    public let reason: Reason

    private enum CodingKeys: String, CodingKey {
        case at, reason
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        at = try container.decodeTimestamp(forKey: .at)
        reason = try container.decode(Reason.self, forKey: .reason)
    }
}

/// A task: a brief the agent runs on a schedule. Alfred's task object, with every field the client shows.
public struct AlfredTask: Decodable, Identifiable, Hashable, Sendable {
    public let id: String
    public let title: String
    /// What each run is asked to do.
    public let brief: String
    public let origin: TaskOrigin
    public let schedule: Schedule
    public let status: TaskStatus
    public let model: TaskModel
    /// The most one run may spend, in USD.
    public let budgetUsd: Double
    public let createdAt: Date
    public let updatedAt: Date
    /// Set only while the task is active.
    public let nextRunAt: Date?
    public let lastRunId: String?
    public let lastRunAt: Date?
    /// The runs the task missed or skipped, newest first.
    public let skips: [TaskSkip]

    private enum CodingKeys: String, CodingKey {
        case id, title, brief, origin, schedule, status, model, budgetUsd, createdAt, updatedAt
        case nextRunAt, lastRunId, lastRunAt, skips
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        title = try container.decode(String.self, forKey: .title)
        brief = try container.decode(String.self, forKey: .brief)
        origin = try container.decode(TaskOrigin.self, forKey: .origin)
        schedule = try container.decode(Schedule.self, forKey: .schedule)
        status = try container.decode(TaskStatus.self, forKey: .status)
        model = try container.decode(TaskModel.self, forKey: .model)
        budgetUsd = try container.decode(Double.self, forKey: .budgetUsd)
        createdAt = try container.decodeTimestamp(forKey: .createdAt)
        updatedAt = try container.decodeTimestamp(forKey: .updatedAt)
        nextRunAt = try container.decodeTimestampIfPresent(forKey: .nextRunAt)
        lastRunId = try container.decodeIfPresent(String.self, forKey: .lastRunId)
        lastRunAt = try container.decodeTimestampIfPresent(forKey: .lastRunAt)
        skips = try container.decode([TaskSkip].self, forKey: .skips)
    }
}

/// A task the owner asks for: what `task.create` sends. Alfred fills in a model and budget that are not given.
public struct TaskDraft: Hashable, Sendable {
    public let title: String
    public let brief: String
    public let schedule: Schedule
    public let model: TaskModel?
    public let budgetUsd: Double?

    public init(title: String, brief: String, schedule: Schedule, model: TaskModel? = nil, budgetUsd: Double? = nil) {
        self.title = title
        self.brief = brief
        self.schedule = schedule
        self.model = model
        self.budgetUsd = budgetUsd
    }
}

/// The changes `task.update` makes. Only the fields that are set are sent.
public struct TaskChanges: Hashable, Sendable {
    public let title: String?
    public let brief: String?
    public let schedule: Schedule?
    public let model: TaskModel?
    public let budgetUsd: Double?
    public let status: TaskStatus?

    public init(
        title: String? = nil,
        brief: String? = nil,
        schedule: Schedule? = nil,
        model: TaskModel? = nil,
        budgetUsd: Double? = nil,
        status: TaskStatus? = nil
    ) {
        self.title = title
        self.brief = brief
        self.schedule = schedule
        self.model = model
        self.budgetUsd = budgetUsd
        self.status = status
    }
}
