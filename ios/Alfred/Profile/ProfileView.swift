import AlfredKit
import SwiftUI

/// Alfred's profile page, pushed from his avatar in the chat: the avatar large with his name, and a segmented control that
/// pins under them with the page's two parts, 规则 and 记忆.
///
/// 规则 shows the root ALFRED.md as Markdown. 编辑 replaces it with an editor; the bar then holds 取消 and 保存, the back
/// button is gone, the control is off and the avatar steps aside, so the owner leaves the editor only by saving or
/// cancelling. The edit is a `RulesDraft`, and a save is made against the version it started from: when the file has
/// changed since, the owner chooses between loading the new content and staying with the draft.
struct ProfileView: View {
    /// The avatar's diameter here. The chat's header draws it at `AvatarMetrics.diameter`.
    static let avatarDiameter: CGFloat = 128

    private enum Part: Hashable {
        case rules
        case memory
    }

    @Environment(AppModel.self) private var model
    @State private var part = Part.rules
    /// The edit in progress; `nil` while the rules are only read.
    @State private var draft: RulesDraft?
    @State private var isSaving = false
    @State private var confirmsDiscarding = false
    /// Whether the first read of the rules has come back, so that the page does not offer a retry before it has tried.
    @State private var hasRead = false
    @FocusState private var editorFocused: Bool

    var body: some View {
        VStack(spacing: 0) {
            // The editor needs the room: with the keyboard up, the avatar would leave it a few lines.
            if draft == nil {
                Hero(state: AvatarState(isWorking: model.runningChatRun != nil))
            }
            content
                .safeAreaBar(edge: .top, spacing: 0) {
                    picker
                }
        }
        .animation(.default, value: draft == nil)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("profile.page")
        .navigationTitle(draft == nil ? "" : "编辑规则")
        .navigationBarTitleDisplayMode(.inline)
        .navigationBarBackButtonHidden(draft != nil)
        .toolbar { bar }
        .task {
            await model.refreshRules()
            hasRead = true
        }
        .confirmationDialog("放弃修改？", isPresented: $confirmsDiscarding, titleVisibility: .visible) {
            Button("放弃修改", role: .destructive) { draft = nil }
        }
        .alert("ALFRED.md 已被改动", isPresented: conflictShown) {
            Button("载入新内容") { Task { await reload() } }
            Button("取消", role: .cancel) {}
        } message: {
            Text("载入新内容会放弃你在这里的修改。")
        }
    }

    // MARK: The page

    private var picker: some View {
        Picker("资料", selection: $part) {
            Text("规则").tag(Part.rules)
            Text("记忆").tag(Part.memory)
        }
        .pickerStyle(.segmented)
        .labelsHidden()
        .disabled(draft != nil)
        .padding(.horizontal)
        .padding(.vertical, 8)
        .accessibilityIdentifier("profile.parts")
    }

    @ViewBuilder
    private var content: some View {
        switch part {
        case .rules:
            if draft == nil {
                reader
            } else {
                editor
            }
        case .memory:
            ContentUnavailableView("暂未开放", systemImage: "brain")
        }
    }

    // MARK: Reading

    private var reader: some View {
        ScrollView {
            if let rules = model.rules {
                if rules.text.isEmpty {
                    ContentUnavailableView("还没有规则", systemImage: "doc.text")
                        .frame(maxWidth: .infinity)
                        .accessibilityIdentifier("profile.rules.empty")
                } else {
                    MarkdownBlocksView(blocks: MarkdownDocument.blocks(from: rules.text))
                        .padding()
                        .accessibilityElement(children: .contain)
                        .accessibilityIdentifier("profile.rules.text")
                }
            } else if model.isLoadingRules || !hasRead {
                ProgressView()
                    .frame(maxWidth: .infinity)
                    .padding(.top, 48)
                    .accessibilityIdentifier("profile.rules.loading")
            } else {
                ContentUnavailableView {
                    Label("无法载入规则", systemImage: "exclamationmark.triangle")
                } actions: {
                    Button("重试") { Task { await model.refreshRules() } }
                        .accessibilityIdentifier("profile.rules.retry")
                }
                .frame(maxWidth: .infinity)
            }
        }
        .refreshable { await Task { _ = await model.refreshRules() }.value }
    }

    // MARK: Editing

    private var editor: some View {
        TextEditor(text: draftText)
            .font(.system(.body, design: .monospaced))
            .autocorrectionDisabled()
            .textInputAutocapitalization(.never)
            .focused($editorFocused)
            .disabled(isSaving)
            .padding(.horizontal, 12)
            .onAppear { editorFocused = true }
            .accessibilityIdentifier("profile.rules.editor")
            .safeAreaBar(edge: .bottom, spacing: 0) {
                count
            }
    }

    /// The bytes the text takes out of the most the server takes, red over it.
    private var count: some View {
        let isOver = draft?.isOverLimit ?? false
        return Text(draft?.countText ?? "")
            .font(.footnote.monospacedDigit())
            .foregroundStyle(isOver ? Color.red : Color.secondary)
            .frame(maxWidth: .infinity, alignment: .trailing)
            .padding(.horizontal)
            .padding(.vertical, 8)
            .accessibilityValue(isOver ? "超出上限" : "")
            .accessibilityIdentifier("profile.rules.count")
    }

    @ToolbarContentBuilder
    private var bar: some ToolbarContent {
        if let draft {
            ToolbarItem(placement: .cancellationAction) {
                Button("取消") { cancelEditing() }
                    .accessibilityIdentifier("profile.cancel")
            }
            ToolbarItem(placement: .confirmationAction) {
                Button("保存") { Task { await save() } }
                    .disabled(!draft.canSave(isSaving: isSaving))
                    .accessibilityIdentifier("profile.save")
            }
        } else if part == .rules {
            ToolbarItem(placement: .topBarTrailing) {
                Button("编辑") { startEditing() }
                    .disabled(model.rules == nil)
                    .accessibilityIdentifier("profile.edit")
            }
        }
    }

    private var draftText: Binding<String> {
        Binding(get: { draft?.text ?? "" }, set: { draft?.text = $0 })
    }

    private var conflictShown: Binding<Bool> {
        Binding(
            get: { draft?.hasConflict ?? false },
            set: { if !$0 { draft?.keepDraft() } }
        )
    }

    private func startEditing() {
        guard let rules = model.rules else { return }
        draft = RulesDraft(rules)
    }

    /// Leaves the editor, after asking when something was typed.
    private func cancelEditing() {
        if draft?.isChanged == true {
            confirmsDiscarding = true
        } else {
            draft = nil
        }
    }

    private func save() async {
        guard let current = draft, current.canSave(isSaving: isSaving) else { return }
        isSaving = true
        defer { isSaving = false }
        switch await model.saveRules(text: current.text, version: current.version) {
        case .saved:
            draft = nil
        case .conflict:
            draft?.noteConflict()
        case .failed:
            // The usual alert says why, and the draft stays.
            break
        }
    }

    /// 载入新内容: the draft becomes what the server holds now. When the read fails, the alert says so and the draft stays.
    private func reload() async {
        guard let fresh = await model.refreshRules() else { return }
        draft?.reload(fresh)
    }
}

/// The avatar large, with his name under it.
private struct Hero: View {
    let state: AvatarState

    var body: some View {
        VStack(spacing: 12) {
            AvatarView(state: state, diameter: ProfileView.avatarDiameter, identifier: "profile.avatar")
            Text("Alfred")
                .font(.title2.bold())
                .accessibilityAddTraits(.isHeader)
                .accessibilityIdentifier("profile.name")
        }
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity)
    }
}
