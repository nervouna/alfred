import AlfredKit
import Foundation

/// Alfred's settings as the app knows them: what `GET /api/settings` returned, and every `settings.updated` event since,
/// with the changes the owner has made that Alfred has not yet confirmed laid over them.
///
/// The settings carry no timestamp, so an event is told apart by its id: one at or below the newest the catalog has
/// applied is ignored. A read or a reply starts at a `revision` (how many events have been applied) and replaces the
/// settings only if no event came meanwhile, because the event is as new as it or newer; the spend `GET /api/settings`
/// reports is not in events, so a read always takes it.
///
/// A change is staged when the owner makes it, moves to in flight when it is sent, and is gone when the call ends.
/// Until then the accessors answer with it, so a control shows what the owner chose; when the call fails the value is
/// back to what the settings say.
struct SettingsCatalog: Hashable {
    /// The settings as Alfred last said them, nil until a read or an event has told.
    private(set) var settings: AlfredSettings?
    /// What the owner has spent today, in USD, as the last read said; nil until a read has.
    private(set) var spentTodayUsd: Double?
    /// How many `settings.updated` events have been applied.
    private(set) var revision = 0
    private var lastEventId: Int64 = 0
    /// Changes made and not sent yet.
    private var staged = SettingsChanges()
    /// Changes in a call that has not ended.
    private var inFlight = SettingsChanges()

    /// Takes the settings and the spend a read returned. `revision` is the catalog's when the read began: if an event has
    /// been applied since, the settings it carries are newer than the read's and stay.
    mutating func load(_ detail: SettingsDetail, requestedAt revision: Int? = nil) {
        spentTodayUsd = detail.spentTodayUsd
        if revision == nil || revision == self.revision {
            settings = detail.settings
        }
    }

    /// A stored `settings.updated` event replaces the settings, unless the catalog has applied a newer one; any other
    /// event changes nothing.
    mutating func apply(_ event: StreamEvent) {
        guard case let .event(stored) = event, case let .settingsUpdated(updated) = stored.payload else { return }
        guard stored.id > lastEventId else { return }
        lastEventId = stored.id
        settings = updated
        revision += 1
    }

    /// Takes the settings a command answered with, under the same rule as a read.
    mutating func confirm(_ updated: AlfredSettings, requestedAt revision: Int) {
        if revision == self.revision {
            settings = updated
        }
    }

    // MARK: The owner's changes

    /// Shows a change at once and holds it for sending. A later change to the same setting replaces it; a setting that is
    /// reset leaves what was staged for it.
    mutating func stage(_ changes: SettingsChanges) {
        staged = staged.merged(with: changes)
    }

    /// Whether a change is waiting to be sent.
    var hasStaged: Bool {
        staged != SettingsChanges()
    }

    /// Takes what is staged for sending: it stays shown until `finishSending`. Nil when nothing is staged.
    mutating func beginSending() -> SettingsChanges? {
        guard hasStaged else { return nil }
        inFlight = staged
        staged = SettingsChanges()
        return inFlight
    }

    /// The call ended, with a reply or a failure: what it carried is no longer laid over the settings.
    mutating func finishSending() {
        inFlight = SettingsChanges()
    }

    // MARK: What the view needs

    /// The settings the owner has overridden, in the contract's order.
    var overridden: [SettingKey] {
        settings?.overridden ?? []
    }

    /// Whether any setting is not at its default: 全部恢复默认 has something to do.
    var canResetAll: Bool {
        !overridden.isEmpty
    }

    var model: TaskModel? { shown(\.model, or: \.model) }
    var dailyBudgetUsd: Double? { shown(\.dailyBudgetUsd, or: \.dailyBudgetUsd) }
    var runBudgetUsd: Double? { shown(\.runBudgetUsd, or: \.runBudgetUsd) }
    var sessionIdleHours: Double? { shown(\.sessionIdleHours, or: \.sessionIdleHours) }
    var compactTokens: Int? { shown(\.compactTokens, or: \.compactTokens) }
    var memoryScanMinutes: Double? { shown(\.memoryScanMinutes, or: \.memoryScanMinutes) }
    var memoryScanBudgetUsd: Double? { shown(\.memoryScanBudgetUsd, or: \.memoryScanBudgetUsd) }

    /// The time of the daily idea generation, nil when it is off.
    var ideasAt: TimeOfDay? {
        switch staged.ideasAt ?? inFlight.ideasAt {
        case let .at(time)?: time
        case .off?: nil
        case nil: settings?.ideasAt
        }
    }

    /// The entries of the 压缩阈值 picker: the two sizes the app sends, in ascending order, with a value the deployment
    /// set in its place among them, and 自动 (0) last.
    var compactTokensChoices: [Int] {
        SettingsPresentation.compactTokensChoices(current: compactTokens)
    }

    /// The models the picker offers: the three Alfred has, and one more if the settings name another.
    var modelChoices: [TaskModel] {
        SettingsPresentation.modelChoices(current: model)
    }

    /// A setting's value: the change staged for it, else the one in flight, else the settings'.
    private func shown<Value>(_ change: KeyPath<SettingsChanges, Value?>, or base: KeyPath<AlfredSettings, Value>) -> Value? {
        staged[keyPath: change] ?? inFlight[keyPath: change] ?? settings?[keyPath: base]
    }
}

extension SettingsChanges {
    /// The changes with `later` laid over them. A setting that `later` sets takes its value, and leaves the reset list; a
    /// setting that `later` resets leaves what was set. The list stays free of repeats.
    func merged(with later: SettingsChanges) -> SettingsChanges {
        func choose<Value>(_ key: SettingKey, _ earlier: Value?, _ latest: Value?) -> Value? {
            latest ?? (later.reset.contains(key) ? nil : earlier)
        }
        let laterSets = later.setKeys
        var reset = self.reset.filter { !laterSets.contains($0) }
        for key in later.reset where !reset.contains(key) {
            reset.append(key)
        }
        return SettingsChanges(
            model: choose(.model, model, later.model),
            dailyBudgetUsd: choose(.dailyBudgetUsd, dailyBudgetUsd, later.dailyBudgetUsd),
            runBudgetUsd: choose(.runBudgetUsd, runBudgetUsd, later.runBudgetUsd),
            sessionIdleHours: choose(.sessionIdleHours, sessionIdleHours, later.sessionIdleHours),
            compactTokens: choose(.compactTokens, compactTokens, later.compactTokens),
            memoryScanMinutes: choose(.memoryScanMinutes, memoryScanMinutes, later.memoryScanMinutes),
            memoryScanBudgetUsd: choose(.memoryScanBudgetUsd, memoryScanBudgetUsd, later.memoryScanBudgetUsd),
            ideasAt: choose(.ideasAt, ideasAt, later.ideasAt),
            reset: reset
        )
    }

    /// The settings this sets (not the ones it resets).
    var setKeys: Set<SettingKey> {
        var keys: Set<SettingKey> = []
        if model != nil { keys.insert(.model) }
        if dailyBudgetUsd != nil { keys.insert(.dailyBudgetUsd) }
        if runBudgetUsd != nil { keys.insert(.runBudgetUsd) }
        if sessionIdleHours != nil { keys.insert(.sessionIdleHours) }
        if compactTokens != nil { keys.insert(.compactTokens) }
        if memoryScanMinutes != nil { keys.insert(.memoryScanMinutes) }
        if memoryScanBudgetUsd != nil { keys.insert(.memoryScanBudgetUsd) }
        if ideasAt != nil { keys.insert(.ideasAt) }
        return keys
    }
}
