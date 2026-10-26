import AlfredKit
import SwiftUI

/// One document: its current version in the viewer of its kind, and the 版本 list behind a toolbar button. Any earlier
/// version opens read-only, under a banner that says so and has a button back to the current one; a Markdown version
/// marks the blocks that changed since the version before it.
///
/// It loads `GET /api/documents/<id>` when it appears, and again when the stream says the document has a new version.
/// The document itself comes from the model's catalog when the catalog knows it, so the file can open before the
/// detail arrives. A screen opened from a message starts on the version that message delivered, and says when a newer
/// one exists.
///
/// The owner annotates here. On the current version of a Markdown or text document, selecting text within a block offers
/// 批注; 整篇批注 comments on any document as a whole. A comment is a draft on the phone until 提交 sends the drafts as one
/// revision. While a revision run of the document is queued or running a banner says so and stops it; when it ends the
/// document is loaded again, each annotation shows Alfred's reply, and the latest revision can be undone from the menu.
struct DocumentScreen: View {
    let documentId: String
    @Environment(AppModel.self) private var model
    @State private var detail: DocumentDetail?
    @State private var failure: String?
    /// The version on screen; `nil` is the current one, whichever that is.
    @State private var selected: String?
    /// Whether `selected` is the version a message delivered, which the owner has not chosen from the list.
    @State private var fromMessage: Bool
    @State private var showsVersions = false
    @State private var download = FileDownload()
    /// The text the version on screen anchors passages on, once its file is read.
    @State private var anchor: Anchored?
    @State private var editor: Editor?
    @State private var showsList = false
    @State private var card: CardRequest?
    @State private var isSubmitting = false
    @State private var confirmsUndo = false
    /// What went wrong with the last thing the owner did here, until the next.
    @State private var notice: String?

    /// `version` is the one a message delivered; without it the screen opens on the current version.
    init(documentId: String, version: String? = nil) {
        self.documentId = documentId
        _selected = State(initialValue: version)
        _fromMessage = State(initialValue: version != nil)
    }

    /// The anchor text of one version of the file.
    struct Anchored: Equatable {
        let version: String
        let text: AnchorText
    }

    /// What the sheet that writes a new comment is for.
    enum Editor: Identifiable {
        case passage(AnnotationTarget)
        case wholeDocument

        var id: String {
            switch self {
            case .passage: "passage"
            case .wholeDocument: "whole"
            }
        }
    }

    struct CardRequest: Identifiable {
        let id: String
    }

    /// The newer of what the request returned and what the model knows.
    private var document: AlfredDocument? {
        let known = model.documentCatalog.document(id: documentId)
        guard let loaded = detail?.document else { return known }
        guard let known else { return loaded }
        return known.updatedAt >= loaded.updatedAt ? known : loaded
    }

    private var versions: [DocumentVersion] {
        detail?.versions ?? []
    }

    private var banner: DocumentPresentation.Banner? {
        guard let document else { return nil }
        return DocumentPresentation.banner(shown: selected, current: document.version, fromMessage: fromMessage, versions: versions)
    }

    // MARK: Annotations

    /// Whether the version on screen is the current one.
    private var isCurrent: Bool {
        guard let document else { return false }
        return selected == nil || selected == document.version
    }

    private var takesPassages: Bool {
        document.map { $0.kind == .markdown || $0.kind == .text } ?? false
    }

    /// The anchor text of the version on screen, when it has been read.
    private var anchorText: AnchorText? {
        guard let document, let anchor, anchor.version == (selected ?? document.version) else { return nil }
        return anchor.text
    }

    private var drafts: [StoredDraft] {
        model.annotationDrafts.drafts(of: documentId)
    }

    private var annotations: [Annotation] {
        AnnotationPresentation.merged(loaded: detail?.annotations ?? [], streamed: model.documentCatalog.annotations(of: documentId))
    }

    /// Whether a target fits the version on screen. A whole-document comment always does; a passage waits for the text.
    private func fits(_ target: AnnotationTarget) -> Bool {
        guard case .passage = target else { return true }
        // Until the text of the version is read nothing is known to be missing from it.
        guard let anchorText else { return takesPassages }
        return anchorText.locate(target) != nil
    }

    private var sections: [AnnotationPresentation.Section] {
        AnnotationPresentation.sections(drafts: drafts, annotations: annotations, fits: fits)
    }

    private var highlights: [AnchorText.Piece: [PassageHighlight]] {
        guard let anchorText else { return [:] }
        return AnnotationPresentation.highlights(drafts: drafts, annotations: annotations, placement: anchorText.locate)
    }

    /// The drafts the submit button sends, on the current version.
    private var batch: [StoredDraft] {
        guard isCurrent else { return [] }
        return model.annotationDrafts.list.batch(documentId: documentId, in: anchorText)
    }

    private var revisionBanner: AnnotationPresentation.RevisionBanner? {
        AnnotationPresentation.revisionBanner(runs: RunPresentation.merged(loaded: detail?.runs ?? [], timeline: model.timeline), documentId: documentId)
    }

    /// The revision runs of the document that are queued or running.
    private var liveRevisions: Set<String> {
        Set(RunPresentation.merged(loaded: detail?.runs ?? [], timeline: model.timeline)
            .filter { $0.kind == .revision && $0.documentId == documentId && !RunPresentation.isEnded($0.status) }
            .map(\.id))
    }

    private var undoOffer: AnnotationPresentation.UndoOffer? {
        guard let document else { return nil }
        return AnnotationPresentation.undoOffer(currentVersion: document.version, versions: versions)
    }

    private var passageAnnotating: PassageAnnotating {
        let text = anchorText
        return PassageAnnotating(
            isEnabled: isCurrent && takesPassages && text != nil,
            highlights: highlights,
            annotate: { piece, range, selection in
                guard let target = text?.target(selecting: range, of: selection, in: piece) else { return }
                editor = .passage(target)
            },
            open: { id in card = CardRequest(id: id) }
        )
    }

    private var actions: AnnotationActions {
        AnnotationActions(
            saveComment: { draft, comment in model.annotationDrafts.setComment(comment, of: draft.id) },
            delete: { model.annotationDrafts.remove(ids: [$0.id]) },
            makeWholeDocument: { draft in
                if let document { model.annotationDrafts.makeWholeDocument(draft.id, version: document.version) }
            },
            reedit: { annotation in
                guard let document else { return }
                model.reedit(annotation, current: document.version, text: isCurrent ? anchorText : nil)
            },
            hasDraftFrom: { annotation in drafts.contains { $0.origin == annotation.id } }
        )
    }

    // MARK: The screen

    var body: some View {
        VStack(spacing: 0) {
            if let banner {
                VersionBanner(banner: banner) { showCurrent() }
            }
            if let revisionBanner {
                RevisionBannerView(banner: revisionBanner) {
                    Task { await model.stop(runId: revisionBanner.runId) }
                }
            }
            if let failure, document != nil, detail == nil {
                Label(failure, systemImage: "exclamationmark.triangle")
                    .font(.footnote)
                    .foregroundStyle(.red)
                    .padding(8)
            }
            content
                .environment(\.passageAnnotating, passageAnnotating)
            if let notice {
                Button {
                    self.notice = nil
                } label: {
                    Label(notice, systemImage: "exclamationmark.triangle")
                        .font(.footnote)
                        .foregroundStyle(.red)
                        .multilineTextAlignment(.leading)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .buttonStyle(.plain)
                .padding(.horizontal)
                .padding(.vertical, 8)
                .background(.bar)
                .accessibilityIdentifier("document.notice")
            }
            if !batch.isEmpty {
                SubmitBar(count: batch.count, isSubmitting: isSubmitting) {
                    Task { await submit() }
                }
            }
        }
        .navigationTitle(document?.title ?? "文档")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { toolbar }
        .sheet(isPresented: $showsVersions) {
            if let document {
                DocumentVersionsView(
                    rows: DocumentPresentation.rows(of: versions),
                    shown: selected ?? document.version,
                    select: select
                )
            }
        }
        .sheet(item: $editor) { editor in
            editorSheet(for: editor)
        }
        .sheet(isPresented: $showsList) {
            AnnotationListView(sections: sections, actions: actions)
        }
        .sheet(item: $card) { request in
            AnnotationCardSheet(found: row(id: request.id), actions: actions)
        }
        .confirmationDialog(undoOffer?.question ?? "", isPresented: $confirmsUndo, titleVisibility: .visible, presenting: undoOffer) { offer in
            Button("撤销修订", role: .destructive) {
                Task { await undo(offer) }
            }
        } message: { _ in
            Text("文档会回到修订之前，作为新的一版；这批批注退回给你。")
        }
        .task { await load() }
        .task(id: AnchorJob(url: download.loadedURL, version: download.key?.version, kind: document?.kind)) {
            await readAnchor()
        }
        .task(id: ReanchorJob(version: document?.version, anchor: anchorText?.id, isCurrent: isCurrent)) {
            reanchorDrafts()
        }
        .onChange(of: document?.version) {
            Task { await load() }
        }
        .onChange(of: liveRevisions) { old, new in
            // A revision run ended: the document, its versions and its annotations have changed.
            if !old.isSubset(of: new) {
                Task { await load() }
            }
        }
    }

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        ToolbarItem(placement: .topBarTrailing) {
            Button {
                showsList = true
            } label: {
                HStack(spacing: 3) {
                    Image(systemName: "text.bubble")
                    let count = AnnotationPresentation.openCount(drafts: drafts, annotations: annotations)
                    if count > 0 {
                        Text("\(count)")
                            .font(.footnote.monospacedDigit())
                    }
                }
            }
            .accessibilityLabel("批注列表")
            .accessibilityValue("\(AnnotationPresentation.openCount(drafts: drafts, annotations: annotations))")
            .accessibilityIdentifier("document.annotations")
        }
        ToolbarItem(placement: .topBarTrailing) {
            Button {
                editor = .wholeDocument
            } label: {
                Image(systemName: "square.and.pencil")
            }
            .disabled(document == nil || !isCurrent)
            .accessibilityLabel("整篇批注")
            .accessibilityIdentifier("document.annotateWhole")
        }
        ToolbarItem(placement: .topBarTrailing) {
            Button {
                showsVersions = true
            } label: {
                Image(systemName: "clock.arrow.circlepath")
            }
            .disabled(versions.isEmpty)
            .accessibilityLabel("版本")
            .accessibilityIdentifier("document.versions")
        }
        if let url = download.loadedURL {
            ToolbarItem(placement: .topBarTrailing) {
                ShareLink(item: url)
                    .accessibilityIdentifier("viewer.share")
            }
        }
        if undoOffer != nil {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button("撤销这次修订", role: .destructive) {
                        confirmsUndo = true
                    }
                    .accessibilityIdentifier("document.undo")
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
                .accessibilityLabel("更多")
                .accessibilityIdentifier("document.menu")
            }
        }
    }

    @ViewBuilder
    private var content: some View {
        if let document {
            let shown = selected ?? document.version
            FileViewer(
                path: document.path,
                version: shown,
                previousVersion: document.kind == .markdown ? DocumentPresentation.previous(of: shown, in: versions) : nil,
                download: download
            )
        } else if let failure {
            ContentUnavailableView {
                Label("无法载入这份文档", systemImage: "exclamationmark.triangle")
            } description: {
                Text(failure)
            } actions: {
                Button("重试") { Task { await load() } }
            }
        } else {
            ProgressView()
        }
    }

    @ViewBuilder
    private func editorSheet(for editor: Editor) -> some View {
        switch editor {
        case let .passage(target):
            AnnotationEditorSheet(title: "批注", quote: quote(of: target)) { comment in
                guard let document else { return }
                model.annotationDrafts.add(documentId: documentId, version: selected ?? document.version, target: target, comment: comment)
            }
        case .wholeDocument:
            AnnotationEditorSheet(title: "整篇批注", quote: nil) { comment in
                guard let document else { return }
                model.annotationDrafts.add(documentId: documentId, version: document.version, target: .document, comment: comment)
            }
        }
    }

    private func quote(of target: AnnotationTarget) -> String? {
        if case let .passage(quote, _, _) = target { quote } else { nil }
    }

    /// The row of the card a highlight opened, with the section it is in.
    private func row(id: String) -> (row: AnnotationPresentation.Row, section: AnnotationPresentation.SectionKind)? {
        for section in sections {
            if let row = section.rows.first(where: { $0.id == id }) {
                return (row, section.kind)
            }
        }
        return nil
    }

    private func select(_ row: DocumentPresentation.VersionRow) {
        selected = row.isCurrent ? nil : row.version
        fromMessage = false
    }

    private func showCurrent() {
        selected = nil
        fromMessage = false
    }

    // MARK: Doing

    private func load() async {
        guard let client = model.client else { return }
        do {
            detail = try await client.document(id: documentId)
            failure = nil
        } catch where LoadFailure.isCancellation(error) {
            return
        } catch {
            failure = LoadFailure.message(for: error)
        }
    }

    private func submit() async {
        guard let document, !isSubmitting else { return }
        isSubmitting = true
        notice = nil
        defer { isSubmitting = false }
        switch await model.submitAnnotations(documentId: documentId, version: document.version, text: anchorText) {
        case .accepted:
            await load()
        case let .conflict(message, reloaded):
            if let reloaded { detail = reloaded }
            notice = message
        case let .rejected(message), let .failed(message):
            notice = message
        case .nothingToSend:
            break
        }
    }

    private func undo(_ offer: AnnotationPresentation.UndoOffer) async {
        notice = nil
        switch await model.undoRevision(documentId: documentId, runId: offer.runId) {
        case .undone:
            showCurrent()
            await load()
        case let .refused(message):
            notice = message
        }
    }

    // MARK: The anchor text

    private struct AnchorJob: Hashable {
        let url: URL?
        let version: String?
        let kind: DocumentKind?
    }

    private struct ReanchorJob: Hashable {
        let version: String?
        let anchor: UUID?
        let isCurrent: Bool
    }

    /// Reads the file on screen and makes the text its passages anchor on, for a Markdown or text document.
    private func readAnchor() async {
        guard let url = download.loadedURL, let version = download.key?.version, let kind = document?.kind,
              kind == .markdown || kind == .text
        else {
            anchor = nil
            return
        }
        do {
            let text = try await Task.detached {
                let content = try FileText.read(url).text
                return kind == .markdown ? AnchorText(markdown: content) : AnchorText(text: content)
            }.value
            anchor = Anchored(version: version, text: text)
        } catch {
            anchor = nil
        }
    }

    /// Drafts written on an earlier version are anchored on the current one once it is on screen: a passage takes the
    /// context it has there, and one that does not fit stays as it was.
    private func reanchorDrafts() {
        guard let document, isCurrent else { return }
        if takesPassages {
            guard let anchorText else { return }
            model.annotationDrafts.reanchor(documentId: documentId, to: document.version, in: anchorText)
        } else {
            model.annotationDrafts.reanchor(documentId: documentId, to: document.version, in: nil)
        }
    }
}


/// The strip over a version that is not the current one: which version it is, and the button to the current one.
private struct VersionBanner: View {
    let banner: DocumentPresentation.Banner
    let showCurrent: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(banner.title)
                    .font(.subheadline.weight(.semibold))
                    .accessibilityIdentifier("document.banner.title")
                if let detail = banner.detail {
                    Text(detail)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 8)
            Button(banner.action, action: showCurrent)
                .buttonStyle(.bordered)
                .accessibilityIdentifier("document.banner.current")
        }
        .padding(.horizontal)
        .padding(.vertical, 10)
        .background(.bar)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("document.banner")
    }
}

/// The 版本 list: every version of the document, newest first, each with what made it, when, and the run that did.
private struct DocumentVersionsView: View {
    let rows: [DocumentPresentation.VersionRow]
    /// The version on screen.
    let shown: String
    let select: (DocumentPresentation.VersionRow) -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List(rows) { row in
                Button {
                    select(row)
                    dismiss()
                } label: {
                    VersionLine(row: row, isShown: row.version == shown)
                }
                .foregroundStyle(.primary)
                .accessibilityIdentifier("document.version.\(row.number)")
            }
            .navigationTitle("版本")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("完成") { dismiss() }
                        .accessibilityIdentifier("document.versions.done")
                }
            }
        }
        .presentationDetents([.medium, .large])
    }
}

private struct VersionLine: View {
    let row: DocumentPresentation.VersionRow
    let isShown: Bool

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(row.title)
                    if row.isCurrent {
                        Text("当前")
                            .font(.caption2)
                            .foregroundStyle(Color.accentColor)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 1)
                            .overlay(Capsule().stroke(Color.accentColor.opacity(0.6), lineWidth: 0.5))
                    }
                }
                HStack(spacing: 6) {
                    Text(row.reason)
                    Text(RunPresentation.relative(row.at))
                    if let runId = row.runId {
                        Text("运行 \(runId)")
                    }
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
            if isShown {
                Image(systemName: "checkmark")
                    .foregroundStyle(Color.accentColor)
                    .accessibilityHidden(true)
            }
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(isShown ? .isSelected : [])
    }
}
