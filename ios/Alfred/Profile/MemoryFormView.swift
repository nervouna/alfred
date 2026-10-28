import AlfredKit
import SwiftUI

/// The form that adds a memory or changes one: a name, a description, a kind and the body. It checks what the contract
/// checks before it sends (`MemoryDraft`). A new memory is opened in a sheet, which wraps the form in a navigation stack;
/// a change is pushed from the memory's page. Leaving a form with changes asks first, and the form is left only by 取消 or
/// by saving.
///
/// A 409 for a stale version offers 重新载入: the list is read again and the draft becomes the memory as it is now, or the
/// pages close when it is gone. Any other refusal, Alfred's own 409 included (he is tidying memory), is shown at the top
/// with the draft kept. A 404 closes the pages and the list is read again.
struct MemoryFormView: View {
    private enum Field: Hashable {
        case name
        case description
    }

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var draft: MemoryDraft
    @State private var isSaving = false
    @State private var confirmsDiscarding = false
    @State private var confirmsReloading = false
    /// The words Alfred or the server refused with, until the next save.
    @State private var refusal: String?
    @FocusState private var focus: Field?

    /// Told when the memory turns out to be gone, so that the page that pushed this one closes too.
    private let onGone: () -> Void

    /// A form for a new memory, or for changing `memory`.
    init(editing memory: Memory? = nil, onGone: @escaping () -> Void = {}) {
        _draft = State(initialValue: memory.map(MemoryDraft.init(editing:)) ?? MemoryDraft())
        self.onGone = onGone
    }

    var body: some View {
        Form {
            if let refusal {
                Section {
                    Label(refusal, systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.red)
                        .textSelection(.enabled)
                }
                .accessibilityIdentifier("memory.form.error")
            }
            Section {
                TextField("名称", text: $draft.name)
                    .focused($focus, equals: .name)
                    .submitLabel(.next)
                    .onSubmit { focus = .description }
                    .accessibilityIdentifier("memory.form.name")
                TextField("描述", text: $draft.description, axis: .vertical)
                    .lineLimit(1...4)
                    .focused($focus, equals: .description)
                    .accessibilityIdentifier("memory.form.description")
            } footer: {
                notes(for: [.nameTooLong, .nameNotOneLine, .descriptionTooLong, .descriptionNotOneLine])
                    .accessibilityIdentifier("memory.form.notes")
            }
            Section {
                Picker("类型", selection: $draft.kind) {
                    ForEach(draft.kindChoices, id: \.self) { kind in
                        Text(MemoryKind(kind).title).tag(kind)
                    }
                }
                .pickerStyle(.menu)
                .accessibilityIdentifier("memory.form.kind")
            } footer: {
                notes(for: [.kindUnknown])
            }
            Section {
                TextEditor(text: $draft.body)
                    .frame(minHeight: 180)
                    .accessibilityIdentifier("memory.form.body")
            } header: {
                Text("正文")
            } footer: {
                count
            }
        }
        .disabled(isSaving)
        .scrollDismissesKeyboard(.interactively)
        .navigationTitle(draft.isNew ? "新建记忆" : "编辑记忆")
        .navigationBarTitleDisplayMode(.inline)
        // The form is left through 取消, which asks when something was typed: no back button, and no swipe down.
        .navigationBarBackButtonHidden(true)
        .interactiveDismissDisabled(draft.isChanged || isSaving)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("取消") { cancel() }
                    .accessibilityIdentifier("memory.form.cancel")
            }
            ToolbarItem(placement: .confirmationAction) {
                Button("保存") { Task { await save() } }
                    .disabled(!draft.canSave(isSaving: isSaving))
                    .accessibilityIdentifier("memory.form.save")
            }
        }
        .onAppear {
            if draft.isNew { focus = .name }
        }
        .confirmationDialog("放弃修改？", isPresented: $confirmsDiscarding, titleVisibility: .visible) {
            Button("放弃修改", role: .destructive) { dismiss() }
        }
        .alert("记忆已被改动", isPresented: $confirmsReloading) {
            Button("重新载入") { Task { await reload() } }
            Button("取消", role: .cancel) {}
        } message: {
            Text("重新载入会放弃你在这里的修改。")
        }
    }

    // MARK: What the draft says about itself

    /// What is wrong with the fields above, in red, or nothing.
    @ViewBuilder
    private func notes(for problems: [MemoryDraft.Problem]) -> some View {
        let messages = draft.problems.filter { problems.contains($0) }.compactMap(\.message)
        if !messages.isEmpty {
            VStack(alignment: .leading, spacing: 2) {
                ForEach(messages, id: \.self) { message in
                    Text(message)
                }
            }
            .foregroundStyle(.red)
        }
    }

    /// The bytes the body takes out of the most the contract takes, red over it.
    private var count: some View {
        Text(draft.bodyCountText)
            .monospacedDigit()
            .foregroundStyle(draft.isBodyOverLimit ? Color.red : Color.secondary)
            .frame(maxWidth: .infinity, alignment: .trailing)
            .accessibilityValue(draft.isBodyOverLimit ? "超出上限" : "")
            .accessibilityIdentifier("memory.form.count")
    }

    // MARK: Leaving and saving

    /// Leaves the form, after asking when something was typed.
    private func cancel() {
        if draft.isChanged {
            confirmsDiscarding = true
        } else {
            dismiss()
        }
    }

    private func save() async {
        guard draft.canSave(isSaving: isSaving) else { return }
        isSaving = true
        refusal = nil
        defer { isSaving = false }
        switch await model.saveMemory(draft) {
        case .saved:
            dismiss()
            // The memory is listed already; the read puts the list in the server's order and counts the prompt again.
            await model.refreshMemories()
        case .stale:
            confirmsReloading = true
        case .gone:
            onGone()
            await model.refreshMemories()
        case let .refused(message):
            refusal = message
        }
    }

    /// 重新载入: the list is read again, and the draft becomes the memory as it is now. When the read fails, the usual
    /// alert says so and the draft stays; when the memory is not in the list any more, the pages close.
    private func reload() async {
        guard let list = await model.refreshMemories() else { return }
        if let fresh = list.memories.first(where: { $0.file == draft.file }) {
            draft.reload(fresh)
        } else {
            onGone()
        }
    }
}
