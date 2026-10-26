import AlfredKit
import SwiftUI

/// The longest comment and the longest quote Alfred takes, in characters.
private let annotationTextLimit = 2000

/// The sheet in which a comment is written: on a passage (with its quote above), on the whole document, or the new words of
/// a draft being edited. 保存 keeps it as a draft.
struct AnnotationEditorSheet: View {
    let title: String
    /// The selected text, for a comment on a passage.
    let quote: String?
    let save: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var comment: String
    @FocusState private var focused: Bool

    init(title: String, quote: String?, comment: String = "", save: @escaping (String) -> Void) {
        self.title = title
        self.quote = quote
        self.save = save
        _comment = State(initialValue: comment)
    }

    private var tooLong: String? {
        if let quote, quote.unicodeScalars.count > annotationTextLimit {
            return "选中的文字超过 \(annotationTextLimit) 个字符，请缩小范围"
        }
        if comment.unicodeScalars.count > annotationTextLimit {
            return "批注超过 \(annotationTextLimit) 个字符"
        }
        return nil
    }

    private var canSave: Bool {
        !comment.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && tooLong == nil
    }

    var body: some View {
        NavigationStack {
            Form {
                if let quote {
                    Section {
                        QuoteText(quote: quote)
                            .accessibilityIdentifier("annotation.sheet.quote")
                    }
                }
                Section {
                    TextField("想让 Alfred 怎么改", text: $comment, axis: .vertical)
                        .lineLimit(3...10)
                        .focused($focused)
                        .accessibilityIdentifier("annotation.sheet.comment")
                } footer: {
                    if let tooLong {
                        Text(tooLong)
                            .foregroundStyle(.red)
                            .accessibilityIdentifier("annotation.sheet.error")
                    }
                }
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                        .accessibilityIdentifier("annotation.sheet.cancel")
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("保存") {
                        save(comment.trimmingCharacters(in: .whitespacesAndNewlines))
                        dismiss()
                    }
                    .disabled(!canSave)
                    .accessibilityIdentifier("annotation.sheet.save")
                }
            }
            .onAppear { focused = true }
        }
        .presentationDetents([.medium, .large])
    }
}

/// A quoted passage: its words behind a bar, as a quote in a document reads.
private struct QuoteText: View {
    let quote: String

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            RoundedRectangle(cornerRadius: 1.5)
                .fill(Color.accentColor.opacity(0.6))
                .frame(width: 3)
            Text(quote)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .lineLimit(6)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .fixedSize(horizontal: false, vertical: true)
    }
}

/// What the owner can do with a draft or an annotation that went back.
struct AnnotationActions {
    /// Keeps the new words of a draft.
    var saveComment: (StoredDraft, String) -> Void
    var delete: (StoredDraft) -> Void
    var makeWholeDocument: (StoredDraft) -> Void
    var reedit: (Annotation) -> Void
    /// Whether an annotation that went back has a draft made from it already.
    var hasDraftFrom: (Annotation) -> Bool
}

/// One annotation: where it is, what the owner wrote, what state it is in and what Alfred answered. The card shows
/// in the 批注 list and, alone, when a highlight is tapped.
struct AnnotationCard: View {
    let row: AnnotationPresentation.Row
    let section: AnnotationPresentation.SectionKind
    let actions: AnnotationActions
    /// Whether the card names its state. The list does not: the section it is under does.
    var showsState = true
    /// The draft being edited, in a sheet this card presents: the list and the card sheet are sheets themselves, and a
    /// sheet can only be presented by what is inside the one before.
    @State private var editing: StoredDraft?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if showsState || row.returnReason != nil {
                header
            }
            if let quote = row.quote {
                QuoteText(quote: quote)
                    .accessibilityIdentifier("annotation.card.quote")
            } else {
                Label("整篇文档", systemImage: "doc.text")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Text(row.comment)
                .font(.body)
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityIdentifier("annotation.card.comment")
            if let reply = row.reply {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Alfred 的回复")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text(reply)
                        .font(.subheadline)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .accessibilityIdentifier("annotation.card.reply")
                }
                .padding(10)
                .background(Color(.tertiarySystemBackground), in: RoundedRectangle(cornerRadius: 10))
            }
            buttons
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("annotation.row.\(identifierName).\(row.id)")
        .sheet(item: $editing) { draft in
            AnnotationEditorSheet(title: "编辑批注", quote: row.quote, comment: draft.comment) { comment in
                actions.saveComment(draft, comment)
            }
        }
    }

    private var identifierName: String {
        switch section {
        case .drafts: "drafts"
        case .submitted: "submitted"
        case .resolved: "resolved"
        case .returned: "returned"
        case .misfit: "misfit"
        }
    }

    private var header: some View {
        HStack(spacing: 6) {
            if showsState {
                Text(section.title)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(tint)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 2)
                    .background(tint.opacity(0.14), in: Capsule())
            }
            if let reason = row.returnReason {
                Text(reason)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("annotation.card.reason")
            }
            Spacer(minLength: 0)
        }
    }

    private var tint: Color {
        switch section {
        case .drafts: .orange
        case .submitted: .blue
        case .resolved: .green
        case .returned: .secondary
        case .misfit: .red
        }
    }

    @ViewBuilder
    private var buttons: some View {
        switch row.source {
        case let .draft(draft):
            HStack(spacing: 16) {
                Button("编辑") { editing = draft }
                    .accessibilityIdentifier("annotation.edit")
                if section == .misfit {
                    Button("改为整篇批注") { actions.makeWholeDocument(draft) }
                        .accessibilityIdentifier("annotation.makeWhole")
                }
                Button("删除", role: .destructive) { actions.delete(draft) }
                    .accessibilityIdentifier("annotation.delete")
            }
            .buttonStyle(.borderless)
            .font(.subheadline)
        case let .annotation(annotation):
            if annotation.state == .returned, !actions.hasDraftFrom(annotation) {
                Button("重新编辑") { actions.reedit(annotation) }
                    .buttonStyle(.borderless)
                    .font(.subheadline)
                    .accessibilityIdentifier("annotation.reedit")
            }
        }
    }
}

/// The 批注 list: drafts, annotations with Alfred, answered ones, ones that went back, and passages that no longer fit.
struct AnnotationListView: View {
    let sections: [AnnotationPresentation.Section]
    let actions: AnnotationActions
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                ForEach(sections) { section in
                    Section {
                        ForEach(section.rows) { row in
                            AnnotationCard(row: row, section: section.kind, actions: actions, showsState: false)
                                .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                                    if case let .draft(draft) = row.source {
                                        Button("删除", role: .destructive) { actions.delete(draft) }
                                    }
                                }
                        }
                    } header: {
                        Text(section.title)
                            .accessibilityIdentifier("annotation.section.\(section.kind)")
                    }
                }
            }
            .overlay {
                if sections.isEmpty {
                    ContentUnavailableView("还没有批注", systemImage: "text.bubble")
                }
            }
            .navigationTitle("批注")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("完成") { dismiss() }
                        .accessibilityIdentifier("annotation.list.done")
                }
            }
        }
        .presentationDetents([.medium, .large])
        .accessibilityIdentifier("annotation.list")
    }
}

/// The card of one highlight, in a sheet. It closes itself when the annotation is gone from the screen (deleted, or
/// answered and moved on).
struct AnnotationCardSheet: View {
    let found: (row: AnnotationPresentation.Row, section: AnnotationPresentation.SectionKind)?
    let actions: AnnotationActions
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Group {
                if let found {
                    ScrollView {
                        AnnotationCard(row: found.row, section: found.section, actions: actions)
                            .padding()
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 16))
                            .padding()
                    }
                } else {
                    Color.clear.onAppear { dismiss() }
                }
            }
            .navigationTitle("批注")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("完成") { dismiss() }
                        .accessibilityIdentifier("annotation.card.done")
                }
            }
        }
        .presentationDetents([.medium, .large])
    }
}

/// The strip over a document while Alfred revises it, with the button that stops the run.
struct RevisionBannerView: View {
    let banner: AnnotationPresentation.RevisionBanner
    let stop: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            if banner.isRunning {
                ProgressView()
                    .controlSize(.small)
            } else {
                Image(systemName: "clock")
                    .foregroundStyle(.secondary)
                    .accessibilityHidden(true)
            }
            Text(banner.title)
                .font(.subheadline.weight(.semibold))
                .accessibilityIdentifier("revision.banner.title")
            Spacer(minLength: 8)
            Button("停止", action: stop)
                .buttonStyle(.bordered)
                .accessibilityIdentifier("revision.stop")
        }
        .padding(.horizontal)
        .padding(.vertical, 10)
        .background(.bar)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("revision.banner")
    }
}

/// The button at the foot of a document that submits its drafts, and what went wrong with the last try.
struct SubmitBar: View {
    let count: Int
    let isSubmitting: Bool
    let submit: () -> Void

    var body: some View {
        Button(action: submit) {
            HStack {
                if isSubmitting {
                    ProgressView()
                        .controlSize(.small)
                }
                Text(AnnotationPresentation.submitTitle(count: count))
                    .frame(maxWidth: .infinity)
            }
        }
        .buttonStyle(.borderedProminent)
        .disabled(isSubmitting)
        .padding(.horizontal)
        .padding(.vertical, 8)
        .background(.bar)
        .accessibilityIdentifier("annotation.submit")
    }
}
