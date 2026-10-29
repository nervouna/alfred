import AlfredKit
import SwiftUI

/// Alfred's profile page, pushed from his avatar in the chat: the avatar large with his name, then a segmented control with
/// the page's two parts, 规则 and 记忆, then the part's content. The avatar and the name are the first thing in that
/// content, in both parts, so they scroll away with it and leave the room to the text or the list; the control moves up
/// with them until it reaches the bottom edge of the navigation bar, where it stays and the content scrolls under it.
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
    /// Whether the content has scrolled up to the control, which the top bar then holds instead of the content.
    @State private var isPinned = false
    /// How far the content has moved from where it rests, as the scroll view counts it (its top inset included).
    @State private var scrolledBy: CGFloat = 0
    /// The hero's height, which is how far the content has to scroll to reach the control, and the control's, which the
    /// bar adds to the content's top inset while it shows.
    @State private var heroHeight: CGFloat = 0
    @State private var controlHeight: CGFloat = 0

    var body: some View {
        content
            .onScrollGeometryChange(for: CGFloat.self) { $0.contentOffset.y + $0.contentInsets.top } action: { _, offset in
                scrolledBy = offset
                updatePinned()
            }
            .onChange(of: heroHeight) { updatePinned() }
            // A part starts at rest, and so does the rules text after an edit.
            .onChange(of: part) { restart() }
            .onChange(of: draft == nil) { restart() }
            // The content scrolls under the bar with the system's soft edge.
            .safeAreaBar(edge: .top, spacing: 0) {
                if showsBar {
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

    private var avatarState: AvatarState {
        AvatarState(isWorking: model.runningChatRun != nil)
    }

    // MARK: The page

    /// The control, in two places. At rest it is the first thing under the hero, in the content, where it scrolls with the
    /// hero and the text. Once the content has scrolled up to the bar, the bar holds another that takes its place there,
    /// and the content scrolls under it with the system's soft edge. One control cannot do both: a bar hosts only what
    /// lies in its frame (a control moved out of it with `offset` was drawn, but its taps were lost). While a draft is
    /// open there is no hero, and the bar's is the only one.
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
        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { controlHeight = $0 }
        .accessibilityIdentifier("profile.parts")
    }

    /// Whether the bar holds the control: the content has scrolled up to it, or there is no hero for it to sit under.
    private var showsBar: Bool {
        draft != nil || isPinned
    }

    /// The hero, with the content's control under it.
    private var header: some View {
        VStack(spacing: 0) {
            ProfileHero(state: avatarState)
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { heroHeight = $0 }
            picker
                .opacity(isPinned ? 0 : 1)
                .accessibilityHidden(isPinned)
        }
    }

    /// Takes the control from the content to the bar once the content has scrolled up to it, and gives it back when the
    /// content scrolls down again. While the bar shows, its room is part of the inset that `scrolledBy` counts from.
    private func updatePinned() {
        guard draft == nil, heroHeight > 0 else { return }
        isPinned = scrolledBy - (isPinned ? controlHeight : 0) >= heroHeight
    }

    private func restart() {
        scrolledBy = 0
        isPinned = false
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
            MemoryListView(header: header)
        }
    }

    // MARK: Reading

    private var reader: some View {
        ScrollView {
            VStack(spacing: 0) {
                header
                rulesText
            }
        }
        .refreshable { await Task { _ = await model.refreshRules() }.value }
    }

    @ViewBuilder
    private var rulesText: some View {
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

/// The avatar large, with his name under it: the first thing in the page's scrolling content, in both parts.
struct ProfileHero: View {
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
