import AlfredKit
import Foundation

/// How a task reads in the app: the words for its status, origin and skips, its next run, and which actions it offers.
enum TaskPresentation {
    static func statusLabel(_ status: TaskStatus) -> String {
        switch status {
        case .active: "已启用"
        case .paused: "已暂停"
        case .done: "已结束"
        default: status.rawValue
        }
    }

    static func originLabel(_ origin: TaskOrigin) -> String {
        switch origin {
        case .manual: "手动"
        case .chat: "对话"
        case .idea: "想法"
        default: origin.rawValue
        }
    }

    /// Why a due run did not run.
    static func skipReason(_ reason: TaskSkip.Reason) -> String {
        switch reason {
        case .missed: "错过（Alfred 当时未运行）"
        case .dailyCap: "已达每日上限"
        default: reason.rawValue
        }
    }

    /// The next run as a date and as a time from now: `10月27日 08:00（5小时后）`. The date is on the device's clock.
    static func nextRun(_ date: Date, in zone: TimeZone = .current) -> String {
        "\(RunPresentation.dateTime(date, in: zone))（\(RunPresentation.relative(date))）"
    }

    /// The button that changes a task's status: 暂停 for an active task, and 恢复 for a paused or an ended one, which goes
    /// back to active. Nil for a status this app does not know.
    static func toggle(_ task: AlfredTask) -> (label: String, status: TaskStatus)? {
        switch task.status {
        case .active: ("暂停", .paused)
        case .paused, .done: ("恢复", .active)
        default: nil
        }
    }

    /// A task's cap per run, as the owner set it: two decimals. A cap is a limit the owner sets, not a cost.
    static func cap(_ usd: Double) -> String {
        String(format: "$%.2f", usd)
    }

    static func canEnd(_ task: AlfredTask) -> Bool {
        task.status != .done
    }
}
