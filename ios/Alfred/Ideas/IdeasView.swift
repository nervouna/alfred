import AlfredKit
import SwiftUI

/// The 想法 tab: the open ideas, each with 采纳, 不要 and 讨论, a button that has Alfred think of ideas now, and the ideas
/// that were accepted, rejected or archived collapsed below. The ideas come from the model, which keeps them current
/// from the stream. Looking at the tab is what marks the open ideas seen (the model does that), which clears the tab's
/// badge.
struct IdeasView: View {
    @Environment(AppModel.self) private var model
    @State private var showsHistory = false
    /// The idea whose accept form is open, and the task it made, to open once the form is gone.
    @State private var accepting: AlfredIdea?
    @State private var acceptedTaskId: String?
    /// The idea the reasons dialog is asking about, and the one whose reason and note are being written.
    @State private var rejecting: AlfredIdea?
    @State private var annotating: AlfredIdea?
    /// A refusal of 现在想想 or of a rejection, until the next action.
    @State private var failure: String?
    @State private var isStarting = false

    var body: some View {
        let open = model.ideaCatalog.open
        let history = model.ideaCatalog.history
        NavigationStack {
            List {
                if let failure {
                    Label(failure, systemImage: "exclamationmark.triangle")
                        .font(.footnote)
                        .foregroundStyle(.red)
                        .textSelection(.enabled)
                        .accessibilityIdentifier("ideas.error")
                }
                if !open.isEmpty {
                    Section {
                        ForEach(open) { idea in
                            IdeaCard(
                                idea: idea,
                                ownerZone: model.taskCatalog.timeZone,
                                accept: { accepting = idea },
                                reject: { rejecting = idea },
                                discuss: { model.discuss(idea) }
                            )
                        }
                    }
                } else if model.ideaCatalog.hasLoaded {
                    Section {
                        ContentUnavailableView {
                            Label("没有待处理的想法", systemImage: "lightbulb")
                        } actions: {
                            generateControl(button: "ideas.empty.generate", progress: "ideas.empty.generating")
                        }
                        .listRowBackground(Color.clear)
                    }
                }
                if !history.isEmpty {
                    Section {
                        HistoryToggle(count: history.count, isExpanded: $showsHistory)
                        if showsHistory {
                            ForEach(history) { idea in
                                HistoryRow(idea: idea) { taskId in model.openTask(id: taskId) }
                            }
                        }
                    }
                }
            }
            .overlay { placeholder(empty: open.isEmpty && !model.ideaCatalog.hasLoaded) }
            .refreshable { await Task { await model.refreshIdeas() }.value }
            .task {
                if !model.ideaCatalog.hasLoaded {
                    await model.refreshIdeas()
                }
            }
            .navigationTitle("想法")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    generateControl(button: "ideas.generate", progress: "ideas.generating")
                }
            }
            .sheet(item: $accepting, onDismiss: openAcceptedTask) { idea in
                TaskFormView(accepting: idea) { task in acceptedTaskId = task.id }
            }
            .sheet(item: $annotating) { idea in
                RejectSheet(idea: idea)
            }
            .confirmationDialog(
                "不要这个想法？",
                isPresented: Binding(get: { rejecting != nil }, set: { if !$0 { rejecting = nil } }),
                titleVisibility: .visible,
                presenting: rejecting
            ) { idea in
                ForEach(IdeaPresentation.reasons, id: \.self) { reason in
                    Button(IdeaPresentation.reasonLabel(reason)) {
                        Task { await reject(idea, reason: reason) }
                    }
                }
                Button("补充一句…") { annotating = idea }
            } message: { idea in
                Text(idea.title)
            }
        }
    }

    // MARK: 现在想想

    /// The button that has Alfred think of ideas now; while a generation is under way, a progress indicator in its place.
    @ViewBuilder
    private func generateControl(button: String, progress: String) -> some View {
        if model.ideaCatalog.isGenerating || isStarting {
            HStack(spacing: 6) {
                ProgressView()
                Text("正在想…")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier(progress)
        } else {
            Button("现在想想") { Task { await generate() } }
                .accessibilityIdentifier(button)
        }
    }

    private func generate() async {
        guard !isStarting else { return }
        isStarting = true
        failure = nil
        defer { isStarting = false }
        do {
            try await model.generateIdeas()
        } catch {
            failure = LoadFailure.commandMessage(for: error)
        }
    }

    // MARK: 不要 and 采纳

    private func reject(_ idea: AlfredIdea, reason: RejectionReason) async {
        failure = nil
        do {
            try await model.rejectIdea(id: idea.id, reason: reason, note: nil)
        } catch {
            failure = LoadFailure.commandMessage(for: error)
        }
    }

    /// The accept form has closed. When it made a task, the 任务 tab shows it.
    private func openAcceptedTask() {
        guard let taskId = acceptedTaskId else { return }
        acceptedTaskId = nil
        model.openTask(id: taskId)
    }

    // MARK: Before the list is there

    @ViewBuilder
    private func placeholder(empty: Bool) -> some View {
        if empty {
            if let failure = model.ideaFailure {
                ContentUnavailableView {
                    Label("无法载入想法", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(failure)
                } actions: {
                    Button("重试") { Task { await model.refreshIdeas() } }
                }
            } else {
                ProgressView()
            }
        }
    }
}

/// An open idea: what it is called, why Alfred suggests it, its brief (a few lines, and the rest on a tap), what it is,
/// the model with the estimate, and the actions on it.
private struct IdeaCard: View {
    let idea: AlfredIdea
    let ownerZone: String?
    let accept: () -> Void
    let reject: () -> Void
    let discuss: () -> Void
    @State private var isExpanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(idea.title)
                .font(.headline)
            Text(idea.why)
                .font(.subheadline)
                .foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 4) {
                Text(idea.brief)
                    .font(.callout)
                    .lineLimit(isExpanded ? nil : 3)
                    .accessibilityIdentifier("idea.brief.\(idea.id)")
                if IdeaPresentation.isLong(idea.brief) {
                    Button(isExpanded ? "收起" : "展开全文") {
                        withAnimation { isExpanded.toggle() }
                    }
                    .font(.footnote)
                    .buttonStyle(.borderless)
                    .accessibilityIdentifier("idea.expand.\(idea.id)")
                }
            }
            HStack {
                Text(IdeaPresentation.kindWords(idea, ownerZone: ownerZone))
                Spacer(minLength: 8)
                Text(IdeaPresentation.modelLine(idea))
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            HStack(spacing: 10) {
                Button("采纳", action: accept)
                    .buttonStyle(.borderedProminent)
                    .accessibilityIdentifier("idea.accept.\(idea.id)")
                Button("不要", action: reject)
                    .buttonStyle(.bordered)
                    .accessibilityIdentifier("idea.reject.\(idea.id)")
                Spacer(minLength: 8)
                Button("讨论", action: discuss)
                    .buttonStyle(.borderless)
                    .font(.footnote)
                    .accessibilityIdentifier("idea.discuss.\(idea.id)")
            }
            .padding(.top, 2)
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(idea.title)
        .accessibilityIdentifier("idea.card.\(idea.id)")
    }
}

/// An idea that is no longer open: what became of it. An accepted idea opens its task.
private struct HistoryRow: View {
    let idea: AlfredIdea
    let openTask: (String) -> Void

    var body: some View {
        if idea.state == .accepted, let taskId = idea.taskId {
            Button {
                openTask(taskId)
            } label: {
                HStack {
                    content
                    Spacer(minLength: 8)
                    Image(systemName: "chevron.right")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(.tertiary)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("idea.history.\(idea.id)")
        } else {
            content
                .accessibilityIdentifier("idea.history.\(idea.id)")
        }
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(idea.title)
                .lineLimit(2)
            Text(IdeaPresentation.historyStatus(idea))
                .font(.subheadline)
                .foregroundStyle(.secondary)
            if let note = IdeaPresentation.historyNote(idea) {
                Text(note)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

/// The row that opens and closes the history.
private struct HistoryToggle: View {
    let count: Int
    @Binding var isExpanded: Bool

    var body: some View {
        Button {
            withAnimation { isExpanded.toggle() }
        } label: {
            HStack {
                Text("历史")
                Text("\(count)")
                    .foregroundStyle(.secondary)
                Spacer()
                Image(systemName: "chevron.right")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .rotationEffect(.degrees(isExpanded ? 90 : 0))
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(.isHeader)
        .accessibilityValue(isExpanded ? "已展开" : "已折叠")
        .accessibilityIdentifier("ideas.history")
    }
}

/// The small sheet behind 补充一句…: the reasons to pick from, a note of up to 500 characters, and 不要 to send. A
/// refusal shows in the sheet, which stays open.
private struct RejectSheet: View {
    let idea: AlfredIdea
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var reason: RejectionReason?
    @State private var note = ""
    @State private var refusal: String?
    @State private var isSending = false

    var body: some View {
        NavigationStack {
            Form {
                if let refusal {
                    Section {
                        Label(refusal, systemImage: "exclamationmark.triangle")
                            .foregroundStyle(.red)
                            .textSelection(.enabled)
                            .accessibilityIdentifier("idea.reject.error")
                    }
                }
                Section {
                    ForEach(IdeaPresentation.reasons, id: \.self) { candidate in
                        Button {
                            reason = candidate
                        } label: {
                            HStack {
                                Text(IdeaPresentation.reasonLabel(candidate))
                                    .foregroundStyle(.primary)
                                Spacer()
                                if reason == candidate {
                                    Image(systemName: "checkmark")
                                        .foregroundStyle(Color.accentColor)
                                }
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityAddTraits(reason == candidate ? .isSelected : [])
                        .accessibilityIdentifier("idea.reject.reason.\(candidate.rawValue)")
                    }
                }
                Section {
                    TextField("补充一句（可选）", text: $note, axis: .vertical)
                        .lineLimit(3...8)
                        .onChange(of: note) { _, text in
                            let limited = IdeaPresentation.limited(text)
                            if limited != text { note = limited }
                        }
                        .accessibilityIdentifier("idea.reject.note")
                }
            }
            .navigationTitle(idea.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("不要") { Task { await send() } }
                        .disabled(reason == nil || isSending)
                        .accessibilityIdentifier("idea.reject.send")
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private func send() async {
        guard let reason, !isSending else { return }
        isSending = true
        refusal = nil
        defer { isSending = false }
        do {
            try await model.rejectIdea(id: idea.id, reason: reason, note: note)
            dismiss()
        } catch {
            refusal = LoadFailure.commandMessage(for: error)
        }
    }
}
