import AlfredKit
import SwiftUI

/// The 设置 tab: what is configurable, on one form. A change is sent as soon as it is made and shows as saved at once; a
/// change another device makes, or the chat's `/model`, arrives from the stream and shows without leaving the tab. The
/// settings come from the model, which keeps them current; they are read when the tab appears and on pull to refresh. The
/// notification state and the pairing are the app's own, so they show whether or not Alfred answers.
struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @State private var confirmsResetting = false
    @State private var confirmsUnpairing = false

    private var catalog: SettingsCatalog {
        model.settingsCatalog
    }

    var body: some View {
        NavigationStack {
            Form {
                if catalog.settings == nil {
                    loading
                } else {
                    if let failure = model.settingsFailure {
                        Label(failure, systemImage: "exclamationmark.triangle")
                            .font(.footnote)
                            .foregroundStyle(.red)
                            .textSelection(.enabled)
                            .accessibilityIdentifier("settings.error")
                    }
                    modelSection
                    spendSection
                    sessionSection
                    memorySection
                    ideasSection
                }
                notificationSection
                deviceSection
                versionSection
            }
            .refreshable { await Task { await model.refreshSettings() }.value }
            .task {
                async let notifications: Void = model.refreshNotificationState()
                await model.refreshSettings()
                await notifications
            }
            .navigationTitle("设置")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button("全部恢复默认", systemImage: "arrow.counterclockwise", role: .destructive) {
                            confirmsResetting = true
                        }
                        .disabled(!catalog.canResetAll)
                        .accessibilityIdentifier("settings.resetAll")
                    } label: {
                        Image(systemName: "ellipsis")
                    }
                    .accessibilityLabel("更多")
                    .accessibilityIdentifier("settings.menu")
                }
            }
            .confirmationDialog("全部恢复默认？", isPresented: $confirmsResetting, titleVisibility: .visible) {
                Button("全部恢复默认", role: .destructive) {
                    Task { await model.updateSettings(SettingsChanges(reset: SettingsPresentation.keys)) }
                }
                .accessibilityIdentifier("settings.resetAll.confirm")
            }
        }
        .confirmationDialog("取消配对？", isPresented: $confirmsUnpairing, titleVisibility: .visible) {
            Button("取消配对", role: .destructive) { model.unpair() }
                .accessibilityIdentifier("settings.unpair.confirm")
        }
    }

    // MARK: Before the settings are there

    /// Until Alfred has answered: a spinner, or why it has not and a way to ask again.
    private var loading: some View {
        Section {
            if let failure = model.settingsFailure {
                Label(failure, systemImage: "exclamationmark.triangle")
                    .foregroundStyle(.red)
                    .textSelection(.enabled)
                    .accessibilityIdentifier("settings.error")
                Button("重试") { Task { await model.refreshSettings() } }
                    .accessibilityIdentifier("settings.retry")
            } else {
                ProgressView()
                    .frame(maxWidth: .infinity)
                    .accessibilityIdentifier("settings.loading")
            }
        }
    }

    // MARK: Alfred's settings

    private var modelSection: some View {
        Section {
            Picker(
                "模型",
                selection: Binding(
                    get: { catalog.model ?? .sonnet },
                    set: { choice in Task { await model.updateSettings(SettingsChanges(model: choice)) } }
                )
            ) {
                ForEach(catalog.modelChoices, id: \.rawValue) { choice in
                    Text(SettingsPresentation.modelName(choice)).tag(choice)
                }
            }
            .accessibilityIdentifier("settings.model")
        }
    }

    private var spendSection: some View {
        Section("花费") {
            stepper(
                "每日上限", id: "settings.dailyBudget", range: SettingsPresentation.dailyBudget,
                value: \.dailyBudgetUsd, text: SettingsPresentation.cap
            ) { SettingsChanges(dailyBudgetUsd: $0) }
            stepper(
                "单次运行上限", id: "settings.runBudget", range: SettingsPresentation.runBudget,
                value: \.runBudgetUsd, text: SettingsPresentation.cap
            ) { SettingsChanges(runBudgetUsd: $0) }
            LabeledContent("今日已花", value: catalog.spentTodayUsd.map(SettingsPresentation.spent) ?? "—")
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("settings.spentToday")
        }
    }

    private var sessionSection: some View {
        Section("会话") {
            stepper(
                "空闲自动换会话", id: "settings.sessionIdleHours", range: SettingsPresentation.sessionIdleHours,
                value: \.sessionIdleHours, text: SettingsPresentation.idleHours
            ) { SettingsChanges(sessionIdleHours: $0) }
            Picker(
                "压缩阈值",
                selection: Binding(
                    get: { catalog.compactTokens ?? 0 },
                    set: { choice in Task { await model.updateSettings(SettingsChanges(compactTokens: choice)) } }
                )
            ) {
                ForEach(catalog.compactTokensChoices, id: \.self) { choice in
                    Text(SettingsPresentation.compactTokens(choice)).tag(choice)
                }
            }
            .accessibilityIdentifier("settings.compactTokens")
        }
    }

    private var memorySection: some View {
        Section("记忆") {
            stepper(
                "扫描间隔", id: "settings.memoryScanMinutes", range: SettingsPresentation.memoryScanMinutes,
                value: \.memoryScanMinutes, text: SettingsPresentation.scanInterval
            ) { SettingsChanges(memoryScanMinutes: $0) }
            stepper(
                "单次预算", id: "settings.memoryScanBudget", range: SettingsPresentation.memoryScanBudget,
                value: \.memoryScanBudgetUsd, text: SettingsPresentation.cap
            ) { SettingsChanges(memoryScanBudgetUsd: $0) }
        }
    }

    private var ideasSection: some View {
        Section("想法") {
            Toggle(
                "每天生成",
                isOn: Binding(
                    get: { catalog.ideasAt != nil },
                    set: { on in
                        let change = SettingsChanges.IdeasAt.at(SettingsPresentation.defaultIdeasAt)
                        Task { await model.updateSettings(SettingsChanges(ideasAt: on ? change : .off)) }
                    }
                )
            )
            .accessibilityIdentifier("settings.ideasEnabled")
            if let time = catalog.ideasAt {
                DatePicker(
                    "时间",
                    selection: Binding(
                        get: { SettingsPresentation.date(for: catalog.ideasAt ?? time) },
                        set: { model.adjustSettings(SettingsChanges(ideasAt: .at(SettingsPresentation.time(of: $0)))) }
                    ),
                    displayedComponents: .hourAndMinute
                )
                .environment(\.timeZone, SettingsPresentation.timeZone)
                .accessibilityIdentifier("settings.ideasAt")
            }
        }
    }

    /// A row with a stepper for a number: its value is in the row, shows as changed at once, and is sent once the owner
    /// has stopped tapping. A value outside the range (a deployment may set one) comes into it on the first tap.
    private func stepper(
        _ title: String,
        id: String,
        range: SettingsRange,
        value: KeyPath<SettingsCatalog, Double?>,
        text: @escaping (Double) -> String,
        change: @escaping (Double) -> SettingsChanges
    ) -> some View {
        let current = catalog[keyPath: value] ?? range.bounds.lowerBound
        return Stepper(
            value: Binding(
                get: { model.settingsCatalog[keyPath: value] ?? range.bounds.lowerBound },
                set: { proposed in
                    let next = range.normalized(proposed)
                    guard next != model.settingsCatalog[keyPath: value] else { return }
                    model.adjustSettings(change(next))
                }
            ),
            in: range.bounds,
            step: range.step
        ) {
            HStack {
                Text(title)
                Spacer(minLength: 8)
                Text(text(current))
                    .foregroundStyle(.secondary)
            }
        }
        .accessibilityLabel(title)
        .accessibilityValue(text(current))
        .accessibilityIdentifier(id)
    }

    // MARK: Notifications, the device, the app

    private var notificationSection: some View {
        Section("通知") {
            LabeledContent("系统通知", value: SettingsPresentation.authorizationLabel(model.notificationAuthorization))
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("settings.notifications")
            Button("打开系统设置") { model.openNotificationSettings() }
                .accessibilityIdentifier("settings.notifications.open")
        }
    }

    @ViewBuilder
    private var deviceSection: some View {
        if let credentials = model.credentials {
            Section("设备") {
                LabeledContent("服务器", value: SettingsPresentation.serverHost(credentials.server))
                    .accessibilityElement(children: .combine)
                    .accessibilityIdentifier("settings.server")
                LabeledContent("设备", value: credentials.deviceId)
                    .accessibilityElement(children: .combine)
                    .accessibilityIdentifier("settings.device")
                Button("取消配对", role: .destructive) { confirmsUnpairing = true }
                    .accessibilityIdentifier("settings.unpair")
            }
        }
    }

    private var versionSection: some View {
        Section {
            LabeledContent("版本", value: SettingsPresentation.version(Bundle.main.infoDictionary))
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("settings.version")
        }
    }
}
