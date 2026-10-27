import AlfredKit
import Foundation

/// How an idea reads in the app: what it is, what it costs, why it was turned down, and the words 讨论 puts in the
/// composer.
enum IdeaPresentation {
    /// The reasons for turning an idea down, in the order the dialog lists them.
    static let reasons: [RejectionReason] = [.notInterested, .alreadyDoing, .notNow, .tooExpensive, .wrongDirection]

    /// The most characters a rejection's note holds, counted as Alfred counts them: Unicode scalars.
    static let maxNoteChars = 500

    /// A brief longer than this many characters, or with more than this many lines, is cut short in the list.
    private static let longBriefChars = 60
    private static let longBriefLines = 3

    static func reasonLabel(_ reason: RejectionReason) -> String {
        switch reason {
        case .notInterested: "不感兴趣"
        case .alreadyDoing: "已经在做了"
        case .notNow: "时机不对"
        case .tooExpensive: "太贵"
        case .wrongDirection: "方向不对"
        default: reason.rawValue
        }
    }

    /// The note to send: the text without the blanks around it, or `nil` when nothing is left.
    static func note(from text: String) -> String? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    /// The text cut to the note limit.
    static func limited(_ text: String) -> String {
        guard text.unicodeScalars.count > maxNoteChars else { return text }
        var scalars = String.UnicodeScalarView()
        scalars.append(contentsOf: text.unicodeScalars.prefix(maxNoteChars))
        return String(scalars)
    }

    // MARK: The list

    /// What the idea is: `一次性`, or the schedule it proposes in words, as the task list shows it.
    static func kindWords(_ idea: AlfredIdea, ownerZone: String?, deviceZone: TimeZone = .current) -> String {
        guard let schedule = idea.schedule else { return "一次性" }
        return SchedulePresentation.words(schedule, ownerZone: ownerZone, deviceZone: deviceZone)
    }

    /// The estimated cost of one run: `约 $0.05`. Under a cent it says so instead of showing nothing.
    static func estimate(_ usd: Double) -> String {
        usd < 0.005 ? "约 <$0.01" : "约 " + String(format: "$%.2f", usd)
    }

    /// The model with the estimate: `haiku · 约 $0.05`.
    static func modelLine(_ idea: AlfredIdea) -> String {
        "\(idea.model.rawValue) · \(estimate(idea.estimateUsd))"
    }

    /// Whether a brief is worth a way to read it in full: it may not fit the few lines the list gives it.
    static func isLong(_ brief: String) -> Bool {
        brief.count > longBriefChars || brief.split(separator: "\n", omittingEmptySubsequences: false).count > longBriefLines
    }

    // MARK: The last generation

    /// What the top of the list says when the last generation added no ideas: Alfred's note, `这次没有新想法` when it gave
    /// none, and `这次没想成，可以再试一次` when the generation failed. Nothing when it added ideas.
    static func generationLine(_ generation: IdeaGeneration) -> String? {
        guard generation.added == 0 else { return nil }
        if generation.status == .failed { return "这次没想成，可以再试一次" }
        return generation.note.flatMap(note(from:)) ?? "这次没有新想法"
    }

    // MARK: History

    /// What became of an idea that is not open: `已采纳`, `不要：时机不对`, `已归档`, or the state as the server sent it.
    static func historyStatus(_ idea: AlfredIdea) -> String {
        switch idea.state {
        case .accepted: "已采纳"
        case .rejected: idea.rejection.map { "不要：" + reasonLabel($0.reason) } ?? "不要"
        case .archived: "已归档"
        default: idea.state.rawValue
        }
    }

    /// The note the owner gave when rejecting the idea.
    static func historyNote(_ idea: AlfredIdea) -> String? {
        idea.rejection?.note
    }

    // MARK: 讨论

    /// The composer's text after 讨论: what the owner had typed stays, and the idea's title and brief follow after a
    /// blank line. A composer that holds only blanks has nothing to keep.
    static func discussion(of idea: AlfredIdea, after composerText: String) -> String {
        let text = "关于想法「\(idea.title)」：\n\(idea.brief)"
        return composerText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? text : composerText + "\n\n" + text
    }
}
