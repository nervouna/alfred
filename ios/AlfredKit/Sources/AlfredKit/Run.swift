import Foundation

/// A file a run wrote, relative to the workspace, and the tool that wrote it.
public struct RunFile: Decodable, Hashable, Sendable {
    public let path: String
    public let tool: String
}

/// The client's view of a run: one execution of the agent, or a subagent of one.
public struct Run: Decodable, Hashable, Sendable {
    public let id: String
    public let kind: RunKind
    public let taskId: String?
    public let parentRunId: String?
    public let title: String
    public let status: RunStatus
    public let model: String?
    public let startedAt: Date
    public let endedAt: Date?
    public let costUsd: Double
    public let files: [RunFile]
    public let error: String?

    private enum CodingKeys: String, CodingKey {
        case id, kind, taskId, parentRunId, title, status, model, startedAt, endedAt, costUsd, files, error
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        kind = try container.decode(RunKind.self, forKey: .kind)
        taskId = try container.decodeIfPresent(String.self, forKey: .taskId)
        parentRunId = try container.decodeIfPresent(String.self, forKey: .parentRunId)
        title = try container.decode(String.self, forKey: .title)
        status = try container.decode(RunStatus.self, forKey: .status)
        model = try container.decodeIfPresent(String.self, forKey: .model)
        startedAt = try container.decodeTimestamp(forKey: .startedAt)
        endedAt = try container.decodeTimestampIfPresent(forKey: .endedAt)
        costUsd = try container.decode(Double.self, forKey: .costUsd)
        files = try container.decode([RunFile].self, forKey: .files)
        error = try container.decodeIfPresent(String.self, forKey: .error)
    }
}

/// One step of a run's timeline: a tool the run used, and what it was used on.
public struct Step: Decodable, Hashable, Sendable {
    public let at: Date
    public let tool: String
    public let detail: String
    /// Set for a step a subagent took: its role.
    public let agent: String?

    private enum CodingKeys: String, CodingKey {
        case at, tool, detail, agent
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        at = try container.decodeTimestamp(forKey: .at)
        tool = try container.decode(String.self, forKey: .tool)
        detail = try container.decode(String.self, forKey: .detail)
        agent = try container.decodeIfPresent(String.self, forKey: .agent)
    }
}
