import Foundation

/// A bot: a role with its own instructions, model, run budget and tools. Alfred itself is not a bot record: it always
/// exists, is configured by the settings, and is addressed by leaving `botId` out or by `Bot.alfredId`.
public struct Bot: Decodable, Identifiable, Hashable, Sendable {
    /// The id of the default bot, Alfred. A `Bot` never has it.
    public static let alfredId = "alfred"

    /// Whether a `botId` names Alfred: a missing one does, and so does `"alfred"`.
    public static func isAlfred(_ botId: String?) -> Bool {
        botId == nil || botId == alfredId
    }

    /// Lowercase kebab-case ASCII, 1 to 32 characters, fixed at creation.
    public let id: String
    public let name: String
    public let description: String
    /// The role prompt.
    public let instructions: String
    public let model: TaskModel
    /// The most one run may spend, in USD.
    public let runBudgetUsd: Double
    /// The tools the bot may use, each once.
    public let tools: [String]
    public let createdAt: Date
    public let updatedAt: Date

    private enum CodingKeys: String, CodingKey {
        case id, name, description, instructions, model, runBudgetUsd, tools, createdAt, updatedAt
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        name = try container.decode(String.self, forKey: .name)
        description = try container.decode(String.self, forKey: .description)
        instructions = try container.decode(String.self, forKey: .instructions)
        model = try container.decode(TaskModel.self, forKey: .model)
        runBudgetUsd = try container.decode(Double.self, forKey: .runBudgetUsd)
        tools = try container.decode([String].self, forKey: .tools)
        createdAt = try container.decodeTimestamp(forKey: .createdAt)
        updatedAt = try container.decodeTimestamp(forKey: .updatedAt)
    }
}
