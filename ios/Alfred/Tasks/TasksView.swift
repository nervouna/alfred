import AlfredKit
import SwiftUI

/// The 任务 tab: the owner's tasks, with the ones that have ended collapsed below, and the recent runs under them. The
/// tasks come from the model, which keeps them current from the stream; the runs are fetched when the tab appears and
/// on pull to refresh, and a run the stream knows takes its status from there. When the model asks for a task
/// (`openTask`, for an accepted idea) the tab opens its detail.
struct TasksView: View {
    @Environment(AppModel.self) private var model
    @State private var loaded = LoadedRuns()
    @State private var showsEnded = false
    @State private var creating = false
    @State private var requested: TaskRoute?

    private var runs: [Run] {
        RunPresentation.merged(loaded: loaded.runs, timeline: model.timeline)
    }

    private var failure: String? {
        loaded.failure ?? model.taskFailure
    }

    var body: some View {
        let open = model.taskCatalog.open
        let ended = model.taskCatalog.ended
        NavigationStack {
            List {
                if let failure, !(open.isEmpty && ended.isEmpty && runs.isEmpty) {
                    Label(failure, systemImage: "exclamationmark.triangle")
                        .font(.footnote)
                        .foregroundStyle(.red)
                }
                if !open.isEmpty {
                    Section {
                        ForEach(open) { task in
                            row(task)
                        }
                    }
                }
                if !ended.isEmpty {
                    Section {
                        EndedToggle(count: ended.count, isExpanded: $showsEnded)
                        if showsEnded {
                            ForEach(ended) { task in
                                row(task)
                            }
                        }
                    }
                }
                if !runs.isEmpty {
                    Section("最近运行") {
                        ForEach(runs, id: \.id) { run in
                            NavigationLink {
                                RunDetailView(runId: run.id)
                            } label: {
                                RunRow(run: run)
                            }
                            .accessibilityIdentifier("run.row.\(run.id)")
                        }
                    }
                } else if loaded.hasLoaded, loaded.failure == nil, !(open.isEmpty && ended.isEmpty) {
                    Section("最近运行") {
                        Text("还没有运行")
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .overlay { placeholder(empty: open.isEmpty && ended.isEmpty && runs.isEmpty) }
            .refreshable { await Task { await reload() }.value }
            .task { await reload() }
            .task(id: model.taskOpenRequest) {
                guard let request = model.taskOpenRequest else { return }
                requested = TaskRoute(taskId: request.taskId)
                model.taskOpenHandled(request)
            }
            .navigationDestination(item: $requested) { route in
                TaskDetailView(taskId: route.taskId)
            }
            .navigationTitle("任务")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        creating = true
                    } label: {
                        Image(systemName: "plus")
                    }
                    .accessibilityLabel("新建任务")
                    .accessibilityIdentifier("tasks.add")
                }
            }
            .sheet(isPresented: $creating) {
                TaskFormView(editing: nil)
            }
        }
    }

    private func row(_ task: AlfredTask) -> some View {
        NavigationLink {
            TaskDetailView(taskId: task.id)
        } label: {
            TaskRow(task: task, ownerZone: model.taskCatalog.timeZone)
        }
        .accessibilityIdentifier("task.row.\(task.id)")
    }

    @ViewBuilder
    private func placeholder(empty: Bool) -> some View {
        if empty {
            if let failure {
                ContentUnavailableView {
                    Label("无法载入任务和运行", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(failure)
                } actions: {
                    Button("重试") { Task { await reload() } }
                }
            } else if loaded.hasLoaded {
                ContentUnavailableView("还没有运行", systemImage: "checklist")
            } else {
                ProgressView()
            }
        }
    }

    private func reload() async {
        async let tasks: Void = model.refreshTasks()
        await loaded.load(using: model.client)
        await tasks
    }
}

/// A task's detail, as the model asked the tab to open it.
private struct TaskRoute: Hashable {
    let taskId: String
}

/// The row that opens and closes the ended tasks.
private struct EndedToggle: View {
    let count: Int
    @Binding var isExpanded: Bool

    var body: some View {
        Button {
            withAnimation { isExpanded.toggle() }
        } label: {
            HStack {
                Text("已结束")
                Text("\(count)")
                    .foregroundStyle(.secondary)
                Spacer()
                Image(systemName: "chevron.right")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .rotationEffect(.degrees(isExpanded ? 90 : 0))
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(.isHeader)
        .accessibilityValue(isExpanded ? "已展开" : "已折叠")
        .accessibilityIdentifier("tasks.ended")
    }
}

/// A task in a list: its title, its schedule in words and when it runs next. A paused task says so instead.
private struct TaskRow: View {
    let task: AlfredTask
    let ownerZone: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Text(task.title)
                    .lineLimit(2)
                if task.status == .paused {
                    Text(TaskPresentation.statusLabel(.paused))
                        .font(.caption2)
                        .foregroundStyle(.orange)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 1)
                        .overlay(Capsule().stroke(.orange.opacity(0.6), lineWidth: 0.5))
                }
            }
            Text(SchedulePresentation.words(task.schedule, ownerZone: ownerZone))
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .lineLimit(1)
            if let next = task.nextRunAt {
                Text("下次 " + RunPresentation.relative(next))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .accessibilityElement(children: .combine)
    }
}
