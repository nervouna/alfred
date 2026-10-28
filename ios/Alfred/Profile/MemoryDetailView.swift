import AlfredKit
import SwiftUI

/// One memory's page: its name, kind and date, the description, and the body as Markdown. 编辑 pushes the form. The page
/// shows the memory as the model holds it, so a save shows at once; when the memory leaves the list (a read that no longer
/// has it, or a 404), the page closes.
struct MemoryDetailView: View {
    let file: String

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    /// The memory the form is open on, as it was when the owner tapped 编辑; `nil` while the form is closed.
    @State private var edited: Memory?

    var body: some View {
        let memory = model.memoryCatalog.memory(file: file)
        Group {
            if let memory {
                page(memory)
            } else {
                ContentUnavailableView("这条记忆已不存在", systemImage: "brain")
            }
        }
        .navigationTitle("")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("编辑") { edited = memory }
                    .disabled(memory == nil)
                    .accessibilityIdentifier("memory.detail.edit")
            }
        }
        .navigationDestination(item: $edited) { memory in
            MemoryFormView(editing: memory, onGone: close)
        }
        .onChange(of: memory == nil) { _, isGone in
            // While the form is open it decides what to do with a memory that went (MemoryFormView).
            if isGone, edited == nil { dismiss() }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("memory.detail")
    }

    /// The form found the memory gone: it and this page close together.
    private func close() {
        edited = nil
        dismiss()
    }

    private func page(_ memory: Memory) -> some View {
        let kind = MemoryKind(memory.kind)
        return ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text(memory.name)
                    .font(.title2.bold())
                    .accessibilityAddTraits(.isHeader)
                    .accessibilityIdentifier("memory.detail.name")
                HStack {
                    Label(kind.title, systemImage: kind.symbol)
                        .accessibilityIdentifier("memory.detail.kind")
                    Spacer(minLength: 8)
                    if !memory.updated.isEmpty {
                        Text(memory.updated)
                            .accessibilityIdentifier("memory.detail.date")
                    }
                }
                .font(.subheadline)
                .foregroundStyle(.secondary)
                if !memory.description.isEmpty {
                    Text(memory.description)
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier("memory.detail.description")
                }
                Divider()
                if memory.body.isEmpty {
                    Text("没有正文")
                        .foregroundStyle(.secondary)
                } else {
                    MarkdownBlocksView(blocks: MarkdownDocument.blocks(from: memory.body))
                        .accessibilityElement(children: .contain)
                        .accessibilityIdentifier("memory.detail.body")
                }
            }
            .padding()
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}
