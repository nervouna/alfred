import Foundation

/// A setting the owner can change: the eight keys of the settings table. A key this client does not know decodes as it
/// is, so a newer Alfred can add one.
public struct SettingKey: ExtensibleString {
    public let rawValue: String

    public init(rawValue: String) {
        self.rawValue = rawValue
    }

    public static let model = SettingKey(rawValue: "model")
    public static let dailyBudgetUsd = SettingKey(rawValue: "dailyBudgetUsd")
    public static let runBudgetUsd = SettingKey(rawValue: "runBudgetUsd")
    public static let sessionIdleHours = SettingKey(rawValue: "sessionIdleHours")
    public static let compactTokens = SettingKey(rawValue: "compactTokens")
    public static let memoryScanMinutes = SettingKey(rawValue: "memoryScanMinutes")
    public static let memoryScanBudgetUsd = SettingKey(rawValue: "memoryScanBudgetUsd")
    public static let ideasAt = SettingKey(rawValue: "ideasAt")
}

/// The settings as Alfred holds them: the effective value of each, and the ones the owner has overridden.
public struct AlfredSettings: Decodable, Hashable, Sendable {
    /// The chat's model.
    public let model: TaskModel
    /// The spend per day, in USD.
    public let dailyBudgetUsd: Double
    /// The spend cap of one chat run, in USD.
    public let runBudgetUsd: Double
    /// Idle hours before a new session. 0 turns rotation off.
    public let sessionIdleHours: Double
    /// The context size, in tokens, that triggers compaction. 0 keeps Claude Code's own window.
    public let compactTokens: Int
    /// Minutes between memory scans. 0 turns them off.
    public let memoryScanMinutes: Double
    /// The spend cap of one memory scan, in USD.
    public let memoryScanBudgetUsd: Double
    /// The time of the daily idea generation, or nil when it is off.
    public let ideasAt: TimeOfDay?
    /// The settings the owner has set to something other than the default, in the table's order.
    public let overridden: [SettingKey]
}

/// The changes `settings.update` makes. A setting left nil is not sent, so Alfred keeps it as it is.
public struct SettingsChanges: Hashable, Sendable {
    /// A change to the time of the daily idea generation: set it to a time, or turn it off.
    public enum IdeasAt: Hashable, Sendable {
        case at(TimeOfDay)
        case off
    }

    public let model: TaskModel?
    public let dailyBudgetUsd: Double?
    public let runBudgetUsd: Double?
    public let sessionIdleHours: Double?
    public let compactTokens: Int?
    public let memoryScanMinutes: Double?
    public let memoryScanBudgetUsd: Double?
    public let ideasAt: IdeasAt?
    /// The settings to return to their defaults. Empty when none is reset.
    public let reset: [SettingKey]

    public init(
        model: TaskModel? = nil,
        dailyBudgetUsd: Double? = nil,
        runBudgetUsd: Double? = nil,
        sessionIdleHours: Double? = nil,
        compactTokens: Int? = nil,
        memoryScanMinutes: Double? = nil,
        memoryScanBudgetUsd: Double? = nil,
        ideasAt: IdeasAt? = nil,
        reset: [SettingKey] = []
    ) {
        self.model = model
        self.dailyBudgetUsd = dailyBudgetUsd
        self.runBudgetUsd = runBudgetUsd
        self.sessionIdleHours = sessionIdleHours
        self.compactTokens = compactTokens
        self.memoryScanMinutes = memoryScanMinutes
        self.memoryScanBudgetUsd = memoryScanBudgetUsd
        self.ideasAt = ideasAt
        self.reset = reset
    }
}

/// The body of `GET /api/settings`: the settings, and what the owner has spent today, in USD.
public struct SettingsDetail: Decodable, Hashable, Sendable {
    public let settings: AlfredSettings
    public let spentTodayUsd: Double
}
