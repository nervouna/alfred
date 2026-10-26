import AlfredKit
import SwiftUI

/// One task: its brief, schedule, next run, model, cap, origin, skips and runs, and the actions on it. It loads when it
/// appears; after that the task comes from the model, which the stream keeps current (`task.updated`), and the runs
/// from the stream's timeline (`run.updated`), so a run that has just been queued appears and finishes on its own.
struct TaskDetailView: View {
    let taskId: String
    @Environment(AppModel.self) private var model
    @State private var detail: TaskDetail?
    @State private var failure: String?
    @State private var actionFailure: String?
    @State private var isWorking = false
    /// The ids of the task's runs at the moment the owner queued one now. The run is queued until one that is not among
    /// them shows up.
    @State private var runsWhenQueued: Set<String>?
    @State private var editing = false
    @State private var confirmsEnding = false

    /// The newer of what the request returned and what the model knows.
    private var task: AlfredTask? {
        let known = model.taskCatalog.task(id: taskId)
        guard let loaded = detail?.task else { return known }
        guard let known else { return loaded }
        return known.updatedAt >= loaded.updatedAt ? known : loaded
    }

    private var runs: [Run] {
        RunPresentation.merged(loaded: detail?.runs ?? [], timeline: model.timeline).filter { $0.taskId == taskId }
    }

    /// The documents the task's runs delivered, most recently updated first.
    private var documents: [AlfredDocument] {
        model.documentCatalog.documents(taskId: taskId)
    }

    private var isQueued: Bool {
        guard let before = runsWhenQueued else { return false }
        return !runs.contains { !before.contains($0.id) }
    }

    var body: some View {
        List {
            if let task {
                header(task)
                actions(task)
                Section("任务说明") {
                    Text(task.brief)
                        .textSelection(.enabled)
                        .accessibilityIdentifier("task.brief")
                }
                details(task)
                if !task.skips.isEmpty {
                    Section("跳过") {
                        ForEach(Array(task.skips.enumerated()), id: \.offset) { _, skip in
                            SkipRow(skip: skip)
                        }
                    }
                }
                if !documents.isEmpty {
                    Section("文档") {
                        ForEach(documents) { document in
                            NavigationLink {
                                DocumentScreen(documentId: document.id)
                            } label: {
                                Label(document.title, systemImage: FileViewerKind(path: document.path).symbol)
                                    .lineLimit(2)
                            }
                            .accessibilityIdentifier("task.document.\(document.id)")
                        }
                    }
                }
                if !runs.isEmpty {
                    Section("运行") {
                        ForEach(runs, id: \.id) { run in
                            NavigationLink {
                                RunDetailView(runId: run.id)
                            } label: {
                                RunRow(run: run)
                            }
                            .accessibilityIdentifier("task.run.\(run.id)")
                        }
                    }
                }
            }
            if let failure, task != nil {
                Label(failure, systemImage: "exclamationmark.triangle")
                    .font(.footnote)
                    .foregroundStyle(.red)
            }
        }
        .overlay { placeholder }
        .navigationTitle(task?.title ?? "任务")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if task != nil {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("编辑") { editing = true }
                        .accessibilityIdentifier("task.edit")
                }
            }
        }
        .sheet(isPresented: $editing) {
            if let task {
                TaskFormView(editing: task)
            }
        }
        .confirmationDialog("结束这个任务？", isPresented: $confirmsEnding, titleVisibility: .visible) {
            Button("结束", role: .destructive) {
                Task { await change(TaskChanges(status: .done)) }
            }
        } message: {
            Text("结束后不再按计划运行。")
        }
        .refreshable { await Task { await load() }.value }
        .task { await load() }
    }

    // MARK: Sections

    private func header(_ task: AlfredTask) -> some View {
        Section {
            VStack(alignment: .leading, spacing: 6) {
                Text(task.title)
                    .font(.headline)
                Text(TaskPresentation.statusLabel(task.status))
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(task.status == .active ? Color.green : task.status == .paused ? Color.orange : Color.secondary)
                    .accessibilityIdentifier("task.status")
            }
        }
    }

    private func actions(_ task: AlfredTask) -> some View {
        Section {
            Button {
                Task { await runNow() }
            } label: {
                Label("立即运行", systemImage: "play")
            }
            .disabled(isWorking)
            .accessibilityIdentifier("task.run")
            if isQueued {
                Label("已排队", systemImage: "clock")
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("task.queued")
            }
            if let toggle = TaskPresentation.toggle(task) {
                let pauses = toggle.status == .paused
                Button {
                    Task { await change(TaskChanges(status: toggle.status)) }
                } label: {
                    Label(toggle.label, systemImage: pauses ? "pause" : "play.circle")
                }
                .disabled(isWorking)
                .accessibilityIdentifier(pauses ? "task.pause" : "task.resume")
            }
            if TaskPresentation.canEnd(task) {
                Button(role: .destructive) {
                    confirmsEnding = true
                } label: {
                    Label("结束", systemImage: "stop.circle")
                }
                .disabled(isWorking)
                .accessibilityIdentifier("task.end")
            }
            if let actionFailure {
                Label(actionFailure, systemImage: "exclamationmark.triangle")
                    .font(.footnote)
                    .foregroundStyle(.red)
                    .textSelection(.enabled)
                    .accessibilityIdentifier("task.error")
            }
        }
    }

    private func details(_ task: AlfredTask) -> some View {
        Section {
            LabeledContent("计划", value: SchedulePresentation.words(task.schedule, ownerZone: model.taskCatalog.timeZone))
            if let next = task.nextRunAt {
                LabeledContent("下次运行", value: TaskPresentation.nextRun(next))
            }
            LabeledContent("模型", value: task.model.rawValue)
            LabeledContent("单次上限", value: TaskPresentation.cap(task.budgetUsd))
            LabeledContent("来源", value: TaskPresentation.originLabel(task.origin))
        }
    }

    @ViewBuilder
    private var placeholder: some View {
        if task == nil {
            if let failure {
                ContentUnavailableView {
                    Label("无法载入这个任务", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(failure)
                } actions: {
                    Button("重试") { Task { await load() } }
                }
            } else {
                ProgressView()
            }
        }
    }

    // MARK: Actions

    private func runNow() async {
        let before = Set(runs.map(\.id))
        await perform {
            try await model.runTask(id: taskId)
            runsWhenQueued = before
        }
    }

    private func change(_ changes: TaskChanges) async {
        await perform { try await model.updateTask(id: taskId, changes: changes) }
    }

    /// Runs one action, one at a time, and shows the server's own words when it refuses.
    private func perform(_ action: () async throws -> Void) async {
        guard !isWorking else { return }
        isWorking = true
        actionFailure = nil
        defer { isWorking = false }
        do {
            try await action()
        } catch {
            actionFailure = LoadFailure.commandMessage(for: error)
        }
    }

    private func load() async {
        guard let client = model.client else { return }
        do {
            detail = try await client.task(id: taskId)
            failure = nil
        } catch where LoadFailure.isCancellation(error) {
            return
        } catch {
            failure = LoadFailure.message(for: error)
        }
    }
}

/// A run the task did not run: why, and when it was due.
private struct SkipRow: View {
    let skip: TaskSkip

    var body: some View {
        HStack {
            Text(TaskPresentation.skipReason(skip.reason))
            Spacer(minLength: 8)
            Text(RunPresentation.dateTime(skip.at))
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
    }
}
