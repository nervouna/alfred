import AlfredKit
import Foundation

/// Settings, settings events and their reads for the settings tests, decoded from the JSON the server sends.
extension TestData {
    /// The settings as the server sends them: Alfred's built-in defaults unless a test says otherwise. `ideasAt` is
    /// `null` when the daily generation is off.
    static func settingsObject(
        model: String = "sonnet",
        dailyBudgetUsd: Double = 20,
        runBudgetUsd: Double = 10,
        sessionIdleHours: Double = 4,
        compactTokens: Int = 100_000,
        memoryScanMinutes: Double = 60,
        memoryScanBudgetUsd: Double = 0.1,
        ideasAt: String? = nil,
        overridden: [String] = []
    ) -> [String: Any] {
        var object: [String: Any] = [
            "model": model, "dailyBudgetUsd": dailyBudgetUsd, "runBudgetUsd": runBudgetUsd,
            "sessionIdleHours": sessionIdleHours, "compactTokens": compactTokens, "memoryScanMinutes": memoryScanMinutes,
            "memoryScanBudgetUsd": memoryScanBudgetUsd, "overridden": overridden,
        ]
        if let ideasAt {
            object["ideasAt"] = ideasAt
        } else {
            object["ideasAt"] = NSNull()
        }
        return object
    }

    static func settings(_ object: [String: Any] = settingsObject()) throws -> AlfredSettings {
        try JSONDecoder().decode(AlfredSettings.self, from: JSONSerialization.data(withJSONObject: object))
    }

    /// The body of `GET /api/settings`.
    static func settingsDetail(_ settings: [String: Any] = settingsObject(), spentTodayUsd: Double = 0) throws -> SettingsDetail {
        try JSONDecoder().decode(SettingsDetail.self, from: settingsDetailData(settings, spentTodayUsd: spentTodayUsd))
    }

    static func settingsDetailData(_ settings: [String: Any] = settingsObject(), spentTodayUsd: Double = 0) throws -> Data {
        try JSONSerialization.data(withJSONObject: ["settings": settings, "spentTodayUsd": spentTodayUsd])
    }

    /// The 200 body of `settings.update`.
    static func settingsResultData(_ settings: [String: Any] = settingsObject()) throws -> Data {
        try JSONSerialization.data(withJSONObject: ["settings": settings])
    }

    /// A stored `settings.updated` event.
    static func settingsEvent(_ eventId: Int, settings: [String: Any], at: String = "2026-10-29T08:00:00.000Z") -> [String: Any] {
        ["id": eventId, "at": at, "type": "settings.updated", "data": settings]
    }
}
