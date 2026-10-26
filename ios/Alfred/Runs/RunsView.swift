import AlfredKit
import SwiftUI

/// The runs, newest first. The list is fetched when the tab appears and on pull to refresh; a run the stream knows
/// takes its status from there, so a running run updates live.
struct RunsView: View {
    @Environment(AppModel.self) private var model
    @State private var loaded = LoadedRuns()

    private var runs: [Run] {
        RunPresentation.merged(loaded: loaded.runs, timeline: model.timeline)
    }

    var body: some View {
        NavigationStack {
            List {
                if let failure = loaded.failure, !runs.isEmpty {
                    Label(failure, systemImage: "exclamationmark.triangle")
                        .font(.footnote)
                        .foregroundStyle(.red)
                }
                ForEach(runs, id: \.id) { run in
                    NavigationLink {
                        RunDetailView(runId: run.id)
                    } label: {
                        RunRow(run: run)
                    }
                    .accessibilityIdentifier("run.row.\(run.id)")
                }
            }
            .overlay { placeholder }
            .refreshable { await Task { await reload() }.value }
            .task { await reload() }
            .navigationTitle("运行")
        }
    }

    @ViewBuilder
    private var placeholder: some View {
        if runs.isEmpty {
            if let failure = loaded.failure {
                ContentUnavailableView {
                    Label("无法载入运行", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(failure)
                } actions: {
                    Button("重试") { Task { await reload() } }
                }
            } else if loaded.hasLoaded {
                ContentUnavailableView("还没有运行", systemImage: "gearshape.2")
            } else {
                ProgressView()
            }
        }
    }

    private func reload() async {
        await loaded.load(using: model.client)
    }
}

private struct RunRow: View {
    let run: Run

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(run.title)
                .lineLimit(2)
            HStack(spacing: 6) {
                StatusBadge(status: run.status)
                if run.kind == .subagent {
                    Text("子任务")
                        .font(.caption2)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 1)
                        .overlay(Capsule().stroke(.secondary.opacity(0.6), lineWidth: 0.5))
                }
                if let name = RunPresentation.modelName(run.model) {
                    Text(name)
                }
                Text(RunPresentation.cost(run.costUsd))
                Text(RunPresentation.relative(run.startedAt))
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            .lineLimit(1)
        }
        .accessibilityElement(children: .combine)
    }
}

/// A run's status in a word, coloured by how it went.
struct StatusBadge: View {
    let status: RunStatus

    var body: some View {
        Text(RunPresentation.statusLabel(status))
            .font(.caption.weight(.semibold))
            .foregroundStyle(color)
    }

    private var color: Color {
        switch status {
        case .running, .queued: .blue
        case .done: .green
        case .failed: .red
        case .stopped, .lost: .orange
        default: .secondary
        }
    }
}
