import AlfredKit
import Foundation

/// What the create and edit form holds, and what it makes of it: the problems that stop a save, the task to create, or
/// the fields of a task that changed. The form keeps what each schedule kind needs side by side, so switching the kind
/// back and forth loses nothing; only the one in `kind` makes the schedule.
///
/// A form can also accept an idea: it is filled in from the idea, and a one-off idea has a choice of its own among the
/// kinds, `立即`, which sends no schedule (Alfred then runs the task a minute after it is accepted).
struct TaskForm: Equatable {
    enum Kind: Hashable {
        case now, daily, weekly, interval, once

        var title: String {
            switch self {
            case .now: "立即"
            case .daily: "每天"
            case .weekly: "每周"
            case .interval: "每隔"
            case .once: "一次"
            }
        }
    }

    /// Something the contract refuses, found before anything is sent.
    enum Problem: Equatable {
        case blankTitle
        case blankBrief
        case noWeekday
        case oncePassed
        case badBudget

        var message: String {
            switch self {
            case .blankTitle: "请填写标题"
            case .blankBrief: "请填写任务说明"
            case .noWeekday: "请至少选一个星期"
            case .oncePassed: "执行时间已过，请选一个之后的时间"
            case .badBudget: "上限需大于 0，且不超过 \(Int(TaskForm.maxBudgetUsd)) 美元"
            }
        }
    }

    /// The most a run may be capped at, in USD (the contract's).
    static let maxBudgetUsd = 20.0
    /// The range of hours between runs (the contract's).
    static let hoursRange = 1...168
    /// The cap a form starts with, in USD.
    static let defaultBudgetUsd = 2.0
    /// The kinds every form offers.
    static let ordinaryKinds: [Kind] = [.daily, .weekly, .interval, .once]

    var title = ""
    var brief = ""
    var kind = Kind.daily
    /// The time of day of a daily or weekly schedule, in the owner's zone.
    var time = TimeOfDay(hour: 8, minute: 0)
    /// The ISO weekdays of a weekly schedule, 1 for Monday to 7 for Sunday.
    var days: Set<Int> = [1, 2, 3, 4, 5]
    var hours = 6
    var onceAt: Date
    var model = TaskModel.sonnet
    /// The cap as typed, in USD.
    var budgetText = "2"
    /// The task being edited; `nil` when the form makes a new one.
    private let original: AlfredTask?
    /// Whether the form accepts an idea.
    private(set) var isAccepting = false
    /// Whether a task can start `立即`: a one-off idea has no schedule of its own.
    private var offersNow = false

    /// A form for a new task.
    init(now: Date = Date()) {
        original = nil
        onceAt = Self.defaultOnce(after: now)
    }

    /// A form that accepts `idea`: its title, brief and model, a recurring idea's schedule, and a cap of two dollars, or
    /// twice the estimate rounded up to a whole dollar when that is more, at most twenty. A one-off idea starts on `立即`.
    init(accepting idea: AlfredIdea, now: Date = Date()) {
        original = nil
        isAccepting = true
        onceAt = Self.defaultOnce(after: now)
        title = idea.title
        brief = idea.brief
        model = idea.model
        budgetText = String(format: "%g", Self.cap(forEstimate: idea.estimateUsd))
        if let schedule = idea.schedule {
            show(schedule)
        } else {
            offersNow = true
            kind = .now
        }
    }

    /// A form showing a task, to change.
    init(editing task: AlfredTask) {
        original = task
        onceAt = Self.defaultOnce(after: Date())
        title = task.title
        brief = task.brief
        model = task.model
        budgetText = String(format: "%g", task.budgetUsd)
        show(task.schedule)
    }

    /// Sets the schedule fields to `schedule`.
    private mutating func show(_ schedule: Schedule) {
        switch schedule {
        case let .daily(time):
            kind = .daily
            self.time = time
        case let .weekly(days, time):
            kind = .weekly
            self.days = Set(days)
            self.time = time
        case let .interval(hours):
            kind = .interval
            self.hours = hours
        case let .once(at):
            kind = .once
            onceAt = at
        }
    }

    /// The cap an accepted idea starts with, in USD.
    static func cap(forEstimate estimate: Double) -> Double {
        min(maxBudgetUsd, max(defaultBudgetUsd, (2 * estimate).rounded(.up)))
    }

    var isEditing: Bool {
        original != nil
    }

    /// The kinds to choose from: `立即` leads for a one-off idea.
    var kinds: [Kind] {
        offersNow ? [.now] + Self.ordinaryKinds : Self.ordinaryKinds
    }

    /// The models to choose from: Alfred's three, and the task's own when it has another.
    var models: [TaskModel] {
        var models: [TaskModel] = [.sonnet, .opus, .haiku]
        for known in [original?.model, model] {
            if let known, !models.contains(known) { models.append(known) }
        }
        return models
    }

    /// The schedule the form's fields describe. For `立即` that is the one-time fields', which are not sent.
    var schedule: Schedule {
        switch kind {
        case .daily: .daily(time: time)
        case .weekly: .weekly(days: days.sorted(), time: time)
        case .interval: .interval(hours: hours)
        case .once, .now: .once(at: onceAt)
        }
    }

    /// The cap as a number, when the text reads as one. A decimal comma counts as a point.
    var budget: Double? {
        let text = budgetText.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: ",", with: ".")
        guard let value = Double(text), value.isFinite else { return nil }
        return value
    }

    // MARK: Checking

    /// What stops the form from being saved, in the order the form shows its fields. A one-time run is checked when the
    /// form sends it: a new task's, or a changed one. A task that keeps its time can be edited after the time has passed.
    func problems(now: Date = Date()) -> [Problem] {
        var problems: [Problem] = []
        if Self.trimmed(title).isEmpty { problems.append(.blankTitle) }
        if Self.trimmed(brief).isEmpty { problems.append(.blankBrief) }
        if kind == .weekly, days.isEmpty { problems.append(.noWeekday) }
        if kind == .once, onceAt <= now, original?.schedule != schedule { problems.append(.oncePassed) }
        if !(budget.map { $0 > 0 && $0 <= Self.maxBudgetUsd } ?? false) { problems.append(.badBudget) }
        return problems
    }

    // MARK: Saving

    /// The task to create. The form is checked first.
    func draft() -> TaskDraft {
        TaskDraft(title: Self.trimmed(title), brief: Self.trimmed(brief), schedule: schedule, model: model, budgetUsd: budget)
    }

    /// The task an accepted idea becomes, as the owner confirmed it. The form is checked first. `立即` has no schedule.
    func acceptance() -> IdeaAcceptance {
        IdeaAcceptance(
            title: Self.trimmed(title),
            brief: Self.trimmed(brief),
            schedule: kind == .now ? nil : schedule,
            model: model,
            budgetUsd: budget ?? Self.defaultBudgetUsd
        )
    }

    /// The fields of the edited task that changed, or `nil` when none did. The status is never among them: pausing,
    /// resuming and ending are the detail's own actions.
    func changes() -> TaskChanges? {
        guard let original else { return nil }
        let title = Self.trimmed(title)
        let brief = Self.trimmed(brief)
        let changes = TaskChanges(
            title: title != Self.trimmed(original.title) ? title : nil,
            brief: brief != Self.trimmed(original.brief) ? brief : nil,
            schedule: schedule != original.schedule ? schedule : nil,
            model: model != original.model ? model : nil,
            budgetUsd: budget.flatMap { abs($0 - original.budgetUsd) > 1e-9 ? $0 : nil }
        )
        return changes == TaskChanges() ? nil : changes
    }

    // MARK: Time of day

    private static let utc: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0) ?? .gmt
        return calendar
    }()

    /// A time of day as a date whose wall clock in UTC reads that time. A date picker set to UTC shows it as it is, so
    /// the owner's clock is picked whatever zone the device is in.
    static func date(of time: TimeOfDay) -> Date {
        utc.date(from: DateComponents(year: 2000, month: 1, day: 1, hour: time.hour, minute: time.minute)) ?? Date(timeIntervalSince1970: 0)
    }

    static func timeOfDay(of date: Date) -> TimeOfDay {
        let parts = utc.dateComponents([.hour, .minute], from: date)
        return TimeOfDay(hour: parts.hour ?? 0, minute: parts.minute ?? 0)
    }

    /// An hour from `now`, rounded up to a multiple of five minutes.
    private static func defaultOnce(after now: Date) -> Date {
        let target = now.addingTimeInterval(3600).timeIntervalSinceReferenceDate
        return Date(timeIntervalSinceReferenceDate: (target / 300).rounded(.up) * 300)
    }

    private static func trimmed(_ text: String) -> String {
        text.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

/// What `idea.accept` takes: the task as the owner confirmed it in the form. A `nil` schedule makes a one-time task that
/// runs at once.
struct IdeaAcceptance: Equatable {
    let title: String
    let brief: String
    let schedule: Schedule?
    let model: TaskModel
    let budgetUsd: Double
}
