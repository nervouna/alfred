import AlfredKit
import SwiftUI

/// A run in a list: its title, status, model, cost and start time.
struct RunRow: View {
    let run: Run

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(run.title)
                .lineLimit(2)
            HStack(spacing: 6) {
                StatusBadge(status: run.status)
                if let label = RunPresentation.kindLabel(run.kind) {
                    Text(label)
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
