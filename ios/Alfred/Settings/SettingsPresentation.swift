import AlfredKit
import Foundation

/// What a stepper may do: the range the app may write for a setting (the contract's table) and how far one tap moves it.
struct SettingsRange: Hashable {
    let bounds: ClosedRange<Double>
    let step: Double

    /// The nearest value Alfred accepts: inside the range, and cleaned of the error that adding a step leaves.
    func normalized(_ value: Double) -> Double {
        let rounded = (value * 100).rounded() / 100
        return min(max(rounded, bounds.lowerBound), bounds.upperBound)
    }
}

/// How the settings read in the app: the words for the models and the units, the ranges and tiers the controls offer,
/// and the strings of the device and the version.
enum SettingsPresentation {
    /// Every setting, in the contract's order: 全部恢复默认 resets these.
    static let keys: [SettingKey] = [
        .model, .dailyBudgetUsd, .runBudgetUsd, .sessionIdleHours, .compactTokens, .memoryScanMinutes, .memoryScanBudgetUsd, .ideasAt,
    ]

    // The write ranges of the contract's table. A deployment may run outside them, and a stepper brings such a value in on
    // its first tap.
    static let dailyBudget = SettingsRange(bounds: 1...100, step: 5)
    static let runBudget = SettingsRange(bounds: 1...20, step: 1)
    static let sessionIdleHours = SettingsRange(bounds: 0...168, step: 1)
    static let memoryScanMinutes = SettingsRange(bounds: 0...1440, step: 15)
    static let memoryScanBudget = SettingsRange(bounds: 0.05...1, step: 0.05)

    /// The sizes the 压缩阈值 picker offers, besides 自动 (0, Claude Code's own window): 100k is the default.
    static let compactTokensSizes = [100_000, 200_000]

    /// The time the daily generation starts at when the owner turns it on.
    static let defaultIdeasAt = TimeOfDay(hour: 8, minute: 0)

    // MARK: Words

    static func modelName(_ model: TaskModel) -> String {
        switch model {
        case .sonnet: "Sonnet"
        case .opus: "Opus"
        case .haiku: "Haiku"
        default: model.rawValue
        }
    }

    /// The models to pick from: the three, and the model the settings name if it is another, so the picker never
    /// misreports.
    static func modelChoices(current: TaskModel?) -> [TaskModel] {
        let known: [TaskModel] = [.sonnet, .opus, .haiku]
        guard let current, !known.contains(current) else { return known }
        return known + [current]
    }

    /// A spend cap, as the owner set it: two decimals, like a task's cap.
    static func cap(_ usd: Double) -> String {
        TaskPresentation.cap(usd)
    }

    /// What has been spent, like a run's cost: a fraction of a cent does not show as free.
    static func spent(_ usd: Double) -> String {
        RunPresentation.cost(usd)
    }

    /// Idle hours before a new session: 关 for 0, which turns rotation off.
    static func idleHours(_ hours: Double) -> String {
        hours == 0 ? "关" : "\(number(hours)) 小时"
    }

    /// Minutes between memory scans: 关 for 0, and hours once the minutes are a whole number of them.
    static func scanInterval(_ minutes: Double) -> String {
        if minutes == 0 { return "关" }
        if minutes >= 60, minutes.truncatingRemainder(dividingBy: 60) == 0 { return "\(number(minutes / 60)) 小时" }
        return "\(number(minutes)) 分钟"
    }

    /// The context size that triggers compaction: 100k, 150k, or the number itself when it is not a whole thousand. 0 is
    /// 自动, Claude Code's own window.
    static func compactTokens(_ tokens: Int) -> String {
        if tokens == 0 { return "自动" }
        return tokens % 1000 == 0 ? "\(tokens / 1000)k" : "\(tokens)"
    }

    /// The entries of the 压缩阈值 picker, in order: the sizes the app sends and the current one if it is none of them
    /// (the deployment set it) among them from small to large, then 自动.
    static func compactTokensChoices(current: Int?) -> [Int] {
        var sizes = compactTokensSizes
        if let current, current != 0, !sizes.contains(current) {
            sizes.append(current)
            sizes.sort()
        }
        return sizes + [0]
    }

    /// A number without a decimal point when it is whole.
    private static func number(_ value: Double) -> String {
        value == value.rounded() ? String(Int(value)) : String(format: "%g", value)
    }

    // MARK: Notifications

    static func authorizationLabel(_ authorization: NotificationAuthorization?) -> String {
        switch authorization {
        case .allowed?: "已开启"
        case .denied?: "已关闭"
        case .notDetermined?: "未询问"
        case nil: "—"
        }
    }

    // MARK: Time of day

    /// The 24-hour text of a time, as the contract has it.
    static func timeText(_ time: TimeOfDay) -> String {
        String(format: "%02d:%02d", time.hour, time.minute)
    }

    /// The zone the time picker works in. A time of day is a clock reading, not a moment, so it goes through a zone that
    /// has no daylight saving: the picker shows 02:30 on the day the clocks skip it.
    static let timeZone = TimeZone.gmt

    private static let clock: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone.gmt
        return calendar
    }()

    /// The date a time picker shows for a time of day.
    static func date(for time: TimeOfDay) -> Date {
        clock.date(from: DateComponents(year: 2001, month: 1, day: 1, hour: time.hour, minute: time.minute)) ?? Date(timeIntervalSinceReferenceDate: 0)
    }

    /// The time of day a time picker's date stands for.
    static func time(of date: Date) -> TimeOfDay {
        let parts = clock.dateComponents([.hour, .minute], from: date)
        return TimeOfDay(hour: parts.hour ?? 0, minute: parts.minute ?? 0)
    }

    // MARK: The device and the app

    /// The host of the server the app is paired with.
    static func serverHost(_ server: URL) -> String {
        server.host(percentEncoded: false) ?? server.absoluteString
    }

    /// The app's version and build: `1.0 (3)`. Either is left out when the bundle does not have it.
    static func version(_ info: [String: Any]?) -> String {
        let version = info?["CFBundleShortVersionString"] as? String
        let build = info?["CFBundleVersion"] as? String
        switch (version, build) {
        case let (version?, build?): return "\(version) (\(build))"
        case let (version?, nil): return version
        case let (nil, build?): return "(\(build))"
        case (nil, nil): return "—"
        }
    }

    // MARK: Failures

    /// Why a change was not saved, for the alert: the server's own words when it gave any.
    static func saveFailure(_ error: any Error) -> String {
        "设置没有保存：" + LoadFailure.commandMessage(for: error)
    }
}
