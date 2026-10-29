import AlfredKit
import SwiftUI

/// The 记忆 part of Alfred's profile: his long-term memories in an inset-grouped list, one section for each kind, with
/// the avatar and his name as the first row, so they scroll away with the rest. A row opens the memory's page; the search
/// field narrows the list by name, description and body; ＋ opens the form for a new memory; a swipe or the context menu
/// deletes one, behind a confirmation. The list comes from the model, which keeps the owner's own changes in it.
struct MemoryListView: View {
    let avatarState: AvatarState

    @Environment(AppModel.self) private var model
    @State private var query = ""
    @State private var creating = false
    @State private var deleting: Memory?
    @State private var confirmsReloading = false
    /// Whether the first read has come back, so that the page does not offer a retry before it has tried.
    @State private var hasRead = false

    var body: some View {
        let sections = model.memoryCatalog.sections(matching: query)
        List {
            ProfileHero(state: avatarState)
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
                .listRowInsets(EdgeInsets())
            if sections.isEmpty {
                placeholder
            }
            ForEach(sections) { section in
                Section {
                    ForEach(section.memories, id: \.file) { memory in
                        row(memory)
                    }
                } header: {
                    Label(section.kind.title, systemImage: section.kind.symbol)
                        .accessibilityIdentifier("memory.section.\(section.kind.identifier)")
                }
            }
        }
        .listStyle(.insetGrouped)
        .refreshable { await Task { _ = await model.refreshMemories() }.value }
        .searchable(text: $query, prompt: "搜索记忆")
        .searchToolbarBehavior(.minimize)
        .task {
            await model.refreshMemories()
            hasRead = true
        }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    creating = true
                } label: {
                    Image(systemName: "plus")
                }
                .accessibilityLabel("新建记忆")
                .accessibilityIdentifier("memory.add")
            }
        }
        .sheet(isPresented: $creating) {
            NavigationStack {
                MemoryFormView()
            }
        }
        // Not on the row: a swipe action takes its row away, and with it a dialog that hangs on the row.
        .confirmationDialog(
            "删除这条记忆？",
            isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }),
            titleVisibility: .visible,
            presenting: deleting
        ) { memory in
            Button("删除", role: .destructive) { Task { await delete(memory) } }
        } message: { memory in
            Text(memory.name)
        }
        .alert("记忆已被改动", isPresented: $confirmsReloading) {
            Button("重新载入") { Task { await model.refreshMemories() } }
            Button("取消", role: .cancel) {}
        } message: {
            Text("它在别处被改过，没有删除。")
        }
    }

    // MARK: Rows

    private func row(_ memory: Memory) -> some View {
        NavigationLink {
            MemoryDetailView(file: memory.file)
        } label: {
            MemoryRow(memory: memory, isInPrompt: model.memoryCatalog.isInPrompt(memory))
        }
        .accessibilityIdentifier("memory.row.\(memory.file)")
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            Button(role: .destructive) {
                deleting = memory
            } label: {
                Label("删除", systemImage: "trash")
            }
            .accessibilityIdentifier("memory.delete.\(memory.file)")
        }
        .contextMenu {
            Button(role: .destructive) {
                deleting = memory
            } label: {
                Label("删除", systemImage: "trash")
            }
        }
    }

    // MARK: When there is nothing to list

    @ViewBuilder
    private var placeholder: some View {
        let catalog = model.memoryCatalog
        Section {
            if catalog.hasLoaded, catalog.memories.isEmpty {
                ContentUnavailableView("还没有记忆", systemImage: "brain")
                    .accessibilityIdentifier("memory.empty")
            } else if catalog.hasLoaded {
                ContentUnavailableView.search(text: query)
                    .accessibilityIdentifier("memory.noMatch")
            } else if model.isLoadingMemories || !hasRead {
                ProgressView()
                    .frame(maxWidth: .infinity)
                    .accessibilityIdentifier("memory.loading")
            } else {
                ContentUnavailableView {
                    Label("无法载入记忆", systemImage: "exclamationmark.triangle")
                } actions: {
                    Button("重试") { Task { await model.refreshMemories() } }
                        .accessibilityIdentifier("memory.retry")
                }
            }
        }
        .listRowBackground(Color.clear)
    }

    // MARK: Deleting

    private func delete(_ memory: Memory) async {
        switch await model.deleteMemory(memory) {
        case .deleted, .gone:
            // The memory has left the list; the read puts the rest in the server's order and counts the prompt again.
            await model.refreshMemories()
        case .stale:
            confirmsReloading = true
        case .refused:
            // The usual alert has said why.
            break
        }
    }
}

/// A memory in the list: its name, its description on one line, the date it was last written, and a note when it is
/// beyond the part of the list that is in Alfred's prompt.
private struct MemoryRow: View {
    let memory: Memory
    let isInPrompt: Bool

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                Text(memory.name)
                    .lineLimit(2)
                if !memory.description.isEmpty {
                    Text(memory.description)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                if !isInPrompt {
                    Text("不在提示中")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 8)
            if !memory.updated.isEmpty {
                Text(memory.updated)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .fixedSize()
            }
        }
        .accessibilityElement(children: .combine)
    }
}
