import AlfredKit
import SwiftUI

/// One run: its status, its steps, the files it wrote and its error. It loads when it appears and again when the
/// stream says the run's status changed, so the steps of a run that has just ended are there.
struct RunDetailView: View {
    let runId: String
    @Environment(AppModel.self) private var model
    @State private var detail: RunDetail?
    @State private var failure: String?

    private var run: Run? {
        RunPresentation.latest(detail?.run, model.timeline.runs[runId])
    }

    var body: some View {
        List {
            if let run {
                header(run)
                if let error = run.error {
                    Section("错误") {
                        Text(error)
                            .foregroundStyle(.red)
                            .textSelection(.enabled)
                            .accessibilityIdentifier("run.error")
                    }
                }
                if let documentId = run.documentId {
                    Section("文档") {
                        NavigationLink {
                            DocumentScreen(documentId: documentId)
                        } label: {
                            Label(model.documentCatalog.document(id: documentId)?.title ?? "打开文档", systemImage: "doc.text")
                                .lineLimit(2)
                        }
                        .accessibilityIdentifier("run.document")
                    }
                }
                if !run.files.isEmpty {
                    Section("文件") {
                        ForEach(run.files, id: \.path) { file in
                            NavigationLink {
                                FileViewerScreen(path: file.path)
                            } label: {
                                Label(file.path, systemImage: "doc")
                                    .lineLimit(2)
                            }
                            .accessibilityIdentifier("run.file.\(file.path)")
                        }
                    }
                }
            }
            if let detail, !detail.steps.isEmpty {
                Section("步骤") {
                    ForEach(Array(detail.steps.enumerated()), id: \.offset) { _, step in
                        StepRow(step: step)
                    }
                }
            }
            if let failure, run != nil {
                Label(failure, systemImage: "exclamationmark.triangle")
                    .font(.footnote)
                    .foregroundStyle(.red)
            }
        }
        .overlay { placeholder }
        .navigationTitle(run?.title ?? "运行")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await Task { await load() }.value }
        .task { await load() }
        .onChange(of: model.timeline.runs[runId]?.status) {
            Task { await load() }
        }
    }

    @ViewBuilder
    private func header(_ run: Run) -> some View {
        Section {
            VStack(alignment: .leading, spacing: 6) {
                Text(run.title)
                    .font(.headline)
                HStack(spacing: 8) {
                    StatusBadge(status: run.status)
                    if let label = RunPresentation.kindLabel(run.kind) {
                        Text(label)
                    }
                    if let name = RunPresentation.modelName(run.model) {
                        Text(name)
                    }
                    Text(RunPresentation.cost(run.costUsd))
                    Text(RunPresentation.relative(run.startedAt))
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("run.summary")
            if let parent = run.parentRunId {
                NavigationLink {
                    RunDetailView(runId: parent)
                } label: {
                    Label("上级运行：\(model.timeline.runs[parent]?.title ?? parent)", systemImage: "arrow.turn.up.left")
                }
                .accessibilityIdentifier("run.parent")
            }
            if RunPresentation.canStop(run) {
                Button("停止", role: .destructive) {
                    Task { await model.stop(runId: run.id) }
                }
                .accessibilityIdentifier("run.stop")
            }
        }
    }

    @ViewBuilder
    private var placeholder: some View {
        if run == nil {
            if let failure {
                ContentUnavailableView {
                    Label("无法载入这个运行", systemImage: "exclamationmark.triangle")
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

    private func load() async {
        guard let client = model.client else { return }
        do {
            detail = try await client.run(id: runId)
            failure = nil
        } catch where LoadFailure.isCancellation(error) {
            return
        } catch {
            failure = LoadFailure.message(for: error)
        }
    }
}

private struct StepRow: View {
    let step: Step

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                Text(step.tool)
                    .font(.subheadline.weight(.semibold))
                if let agent = step.agent {
                    Text(agent)
                        .font(.caption2)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 1)
                        .overlay(Capsule().stroke(.secondary.opacity(0.6), lineWidth: 0.5))
                }
                Spacer(minLength: 8)
                Text(RunPresentation.clock(step.at))
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
            Text(step.detail)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
        }
        .accessibilityElement(children: .combine)
    }
}
