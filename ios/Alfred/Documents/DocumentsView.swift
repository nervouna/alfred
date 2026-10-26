import AlfredKit
import SwiftUI

/// The 文档 tab: the documents Alfred delivered, most recently updated first. They come from the model, which keeps
/// them current from the stream; the list is read again when the tab appears and on pull to refresh.
struct DocumentsView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        let documents = model.documentCatalog.documents
        NavigationStack {
            List {
                if let failure = model.documentFailure, !documents.isEmpty {
                    Label(failure, systemImage: "exclamationmark.triangle")
                        .font(.footnote)
                        .foregroundStyle(.red)
                }
                ForEach(documents) { document in
                    NavigationLink {
                        DocumentScreen(documentId: document.id)
                    } label: {
                        DocumentRow(document: document, taskTitle: document.taskId.flatMap { model.taskCatalog.task(id: $0)?.title })
                    }
                    .accessibilityIdentifier("document.row.\(document.id)")
                }
            }
            .overlay { placeholder(empty: documents.isEmpty) }
            .refreshable { await Task { await model.refreshDocuments() }.value }
            .task { await model.refreshDocuments() }
            .navigationTitle("文档")
        }
    }

    @ViewBuilder
    private func placeholder(empty: Bool) -> some View {
        if empty {
            if let failure = model.documentFailure {
                ContentUnavailableView {
                    Label("无法载入文档", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(failure)
                } actions: {
                    Button("重试") { Task { await model.refreshDocuments() } }
                }
            } else if model.documentCatalog.hasLoaded {
                ContentUnavailableView("还没有文档", systemImage: "doc.text")
            } else {
                ProgressView()
            }
        }
    }
}

private struct DocumentRow: View {
    let document: AlfredDocument
    /// The name of the task whose run delivered the document, when the app knows the task.
    let taskTitle: String?

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: FileViewerKind(path: document.path).symbol)
                .foregroundStyle(.secondary)
                .frame(width: 24)
            VStack(alignment: .leading, spacing: 2) {
                Text(document.title)
                    .lineLimit(2)
                HStack {
                    let folder = DocumentPresentation.folder(of: document.path)
                    Text(folder.isEmpty ? "工作区" : folder)
                        .lineLimit(1)
                        .truncationMode(.head)
                    Spacer(minLength: 8)
                    Text(RunPresentation.dateTime(document.updatedAt))
                }
                .font(.caption)
                .foregroundStyle(.secondary)
                if let taskTitle {
                    Label(taskTitle, systemImage: "checklist")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
        }
        .accessibilityElement(children: .combine)
    }
}
