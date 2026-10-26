import AlfredKit
import SwiftUI

/// The files Alfred delivered or wrote: those of its messages, and those of the runs the app has loaded, once per
/// path and newest first.
struct DocumentsView: View {
    @Environment(AppModel.self) private var model
    @State private var loaded = LoadedRuns()

    private var entries: [DocumentEntry] {
        DocumentList.entries(timeline: model.timeline, loadedRuns: loaded.runs)
    }

    var body: some View {
        NavigationStack {
            List {
                if let failure = loaded.failure, !entries.isEmpty {
                    Label(failure, systemImage: "exclamationmark.triangle")
                        .font(.footnote)
                        .foregroundStyle(.red)
                }
                ForEach(entries) { entry in
                    NavigationLink {
                        FileViewerScreen(path: entry.path)
                    } label: {
                        DocumentRow(entry: entry)
                    }
                    .accessibilityIdentifier("document.row.\(entry.path)")
                }
            }
            .overlay { placeholder }
            .refreshable { await Task { await reload() }.value }
            .task { await reload() }
            .navigationTitle("文档")
        }
    }

    @ViewBuilder
    private var placeholder: some View {
        if entries.isEmpty {
            if let failure = loaded.failure {
                ContentUnavailableView {
                    Label("无法载入文档", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(failure)
                } actions: {
                    Button("重试") { Task { await reload() } }
                }
            } else if loaded.hasLoaded {
                ContentUnavailableView("还没有文档", systemImage: "doc.text")
            } else {
                ProgressView()
            }
        }
    }

    private func reload() async {
        await loaded.load(using: model.client)
    }
}

private struct DocumentRow: View {
    let entry: DocumentEntry

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: FileViewerKind(path: entry.path).symbol)
                .foregroundStyle(.secondary)
                .frame(width: 24)
            VStack(alignment: .leading, spacing: 2) {
                Text(entry.name)
                    .lineLimit(1)
                    .truncationMode(.middle)
                HStack {
                    Text(entry.folder.isEmpty ? "工作区" : entry.folder)
                        .lineLimit(1)
                        .truncationMode(.head)
                    Spacer(minLength: 8)
                    Text(RunPresentation.dateTime(entry.date))
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }
        }
        .accessibilityElement(children: .combine)
    }
}
