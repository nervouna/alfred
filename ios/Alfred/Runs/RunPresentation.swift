import AlfredKit
import Foundation

/// How runs read in the app: the words for a status, the short model name, the cost, the times, and which runs the
/// list shows. The time text follows the app's Chinese UI whatever the device's language is.
enum RunPresentation {
    private static let locale = Locale(identifier: "zh-Hans")

    static func statusLabel(_ status: RunStatus) -> String {
        switch status {
        case .queued: "排队中"
        case .running: "进行中"
        case .done: "完成"
        case .stopped: "已停止"
        case .failed: "失败"
        case .lost: "中断"
        default: status.rawValue
        }
    }

    /// The label of a run that is not an ordinary task run: `子任务` for a subagent and `想法` for a generation of ideas.
    static func kindLabel(_ kind: RunKind) -> String? {
        switch kind {
        case .subagent: "子任务"
        case .ideas: "想法"
        default: nil
        }
    }

    /// The model without its vendor prefix, as the workbench shows it: `claude-haiku-5-5` is `haiku-5-5`.
    static func modelName(_ model: String?) -> String? {
        guard let model, !model.isEmpty else { return nil }
        return model.hasPrefix("claude-") ? String(model.dropFirst("claude-".count)) : model
    }

    /// A cost in dollars: three decimals under a dollar, so a run that cost a fraction of a cent does not show as free,
    /// and two from a dollar up.
    static func cost(_ usd: Double) -> String {
        String(format: usd < 1 ? "$%.3f" : "$%.2f", usd)
    }

    /// A time as time since: `5分钟前`.
    static func relative(_ date: Date) -> String {
        date.formatted(.relative(presentation: .numeric, unitsStyle: .abbreviated).locale(locale))
    }

    /// A date with its time, for a list of files: `10月26日 08:30`. It reads on the clock of `zone`, the device's by default.
    static func dateTime(_ date: Date, in zone: TimeZone = .current) -> String {
        var style = Date.FormatStyle.dateTime.locale(locale)
        style.timeZone = zone
        return date.formatted(style.month().day().hour().minute())
    }

    /// A time of day to the second, for a run's steps: `08:31:02`.
    static func clock(_ date: Date) -> String {
        date.formatted(.dateTime.locale(locale).hour().minute().second())
    }

    static func isEnded(_ status: RunStatus) -> Bool {
        status == .done || status == .stopped || status == .failed || status == .lost
    }

    /// Only a run that is running has a turn to interrupt.
    static func canStop(_ run: Run) -> Bool {
        run.status == .running
    }

    /// The newer of what a request returned and what the stream last said about the same run. The stream's version
    /// wins, so a running run updates live, unless the request already saw the run end: an ended run does not
    /// start again, and the stream may only be catching up.
    static func latest(_ loaded: Run?, _ streamed: Run?) -> Run? {
        guard let loaded else { return streamed }
        guard let streamed else { return loaded }
        return isEnded(loaded.status) && !isEnded(streamed.status) ? loaded : streamed
    }

    /// The runs the list shows: those the app loaded and those only the stream has told it of, each in its latest
    /// version, newest first.
    static func merged(loaded: [Run], timeline: Timeline) -> [Run] {
        var runs = Dictionary(loaded.map { ($0.id, $0) }, uniquingKeysWith: { _, later in later })
        for streamed in timeline.runs.values {
            runs[streamed.id] = latest(runs[streamed.id], streamed)
        }
        return runs.values.sorted { first, second in
            first.startedAt != second.startedAt ? first.startedAt > second.startedAt : first.id < second.id
        }
    }
}
