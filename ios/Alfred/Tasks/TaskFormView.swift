import AlfredKit
import SwiftUI

/// The form that creates a task, or changes one. It checks what the contract checks before it sends; a refusal from the
/// server shows as its message, and the form keeps what the owner typed. Changing a task sends only the fields that
/// changed.
struct TaskFormView: View {
    private static let weekdayNames = ["一", "二", "三", "四", "五", "六", "日"]

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var form: TaskForm
    @State private var problems: [TaskForm.Problem] = []
    @State private var refusal: String?
    @State private var isSaving = false
    @FocusState private var budgetFocused: Bool

    private let editing: AlfredTask?

    /// A form for a new task, or for changing `task`.
    init(editing task: AlfredTask?) {
        editing = task
        _form = State(initialValue: task.map(TaskForm.init(editing:)) ?? TaskForm())
    }

    var body: some View {
        NavigationStack {
            Form {
                if !problems.isEmpty || refusal != nil {
                    Section {
                        ForEach(problems, id: \.message) { problem in
                            Label(problem.message, systemImage: "exclamationmark.triangle")
                        }
                        if let refusal {
                            Label(refusal, systemImage: "exclamationmark.triangle")
                                .textSelection(.enabled)
                        }
                    }
                    .foregroundStyle(.red)
                    .accessibilityIdentifier("task.form.error")
                }
                Section {
                    TextField("标题", text: $form.title)
                        .accessibilityIdentifier("task.form.title")
                }
                Section("任务说明") {
                    TextEditor(text: $form.brief)
                        .frame(minHeight: 120)
                        .accessibilityIdentifier("task.form.brief")
                }
                Section {
                    Picker("重复", selection: $form.kind) {
                        ForEach(TaskForm.Kind.allCases, id: \.self) { kind in
                            Text(kind.title).tag(kind)
                        }
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()
                    .accessibilityIdentifier("task.form.kind")
                    schedule
                }
                Section("模型") {
                    Picker("模型", selection: $form.model) {
                        ForEach(form.models, id: \.self) { model in
                            Text(model.rawValue).tag(model)
                        }
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()
                    .accessibilityIdentifier("task.form.model")
                }
                Section("单次上限（美元）") {
                    TextField("2", text: $form.budgetText)
                        .keyboardType(.decimalPad)
                        .focused($budgetFocused)
                        .accessibilityIdentifier("task.form.budget")
                }
            }
            .scrollDismissesKeyboard(.interactively)
            .navigationTitle(editing == nil ? "新建任务" : "编辑任务")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                        .accessibilityIdentifier("task.form.cancel")
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("保存") { Task { await save() } }
                        .disabled(isSaving)
                        .accessibilityIdentifier("task.form.save")
                }
                // The decimal pad has no return key.
                ToolbarItemGroup(placement: .keyboard) {
                    if budgetFocused {
                        Spacer()
                        Button("完成") { budgetFocused = false }
                    }
                }
            }
        }
    }

    // MARK: The schedule's controls

    @ViewBuilder
    private var schedule: some View {
        switch form.kind {
        case .daily:
            timeOfDay
        case .weekly:
            weekdays
            timeOfDay
        case .interval:
            Stepper("每隔 \(form.hours) 小时", value: $form.hours, in: TaskForm.hoursRange)
                .accessibilityIdentifier("task.form.hours")
        case .once:
            DatePicker("执行时间", selection: $form.onceAt, displayedComponents: [.date, .hourAndMinute])
                .accessibilityIdentifier("task.form.at")
        }
    }

    /// A time of day on the owner's clock: the picker works in UTC on a date that reads that time, so the device's zone
    /// does not move it.
    private var timeOfDay: some View {
        let note = SchedulePresentation.zoneNote(ownerZone: model.taskCatalog.timeZone, deviceZone: .current)
        return DatePicker(
            note.map { "时间（\($0)）" } ?? "时间",
            selection: Binding(
                get: { TaskForm.date(of: form.time) },
                set: { form.time = TaskForm.timeOfDay(of: $0) }
            ),
            displayedComponents: .hourAndMinute
        )
        .environment(\.timeZone, .gmt)
        .accessibilityIdentifier("task.form.time")
    }

    private var weekdays: some View {
        HStack(spacing: 6) {
            ForEach(1...7, id: \.self) { day in
                let isOn = form.days.contains(day)
                Button {
                    if isOn { form.days.remove(day) } else { form.days.insert(day) }
                } label: {
                    Text(Self.weekdayNames[day - 1])
                        .font(.subheadline.weight(.medium))
                        .frame(maxWidth: .infinity, minHeight: 34)
                        .foregroundStyle(isOn ? Color.white : Color.primary)
                        .background(isOn ? Color.accentColor : Color(.tertiarySystemFill), in: Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("周" + Self.weekdayNames[day - 1])
                .accessibilityAddTraits(isOn ? .isSelected : [])
                .accessibilityIdentifier("task.form.day.\(day)")
            }
        }
    }

    // MARK: Saving

    private func save() async {
        guard !isSaving else { return }
        refusal = nil
        problems = form.problems()
        guard problems.isEmpty else { return }
        isSaving = true
        defer { isSaving = false }
        do {
            if let editing {
                // A form that changed nothing has nothing to send, and the server refuses an empty change.
                if let changes = form.changes() {
                    try await model.updateTask(id: editing.id, changes: changes)
                }
            } else {
                try await model.createTask(form.draft())
            }
            dismiss()
        } catch {
            refusal = LoadFailure.commandMessage(for: error)
        }
    }
}
