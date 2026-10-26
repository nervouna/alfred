import AlfredKit
import Foundation

/// A passage the viewer paints: a draft's, or a submitted annotation's.
struct PassageHighlight: Hashable, Sendable {
    enum Kind: Hashable, Sendable {
        case draft
        case submitted
    }

    /// The draft's or the annotation's id.
    let id: String
    let kind: Kind
    /// Where it is in the piece's text, in UTF-16.
    let range: NSRange

    /// What VoiceOver calls it.
    var label: String {
        AnnotationPresentation.highlightLabel(kind)
    }
}

/// How annotations read in the app: the sections of the 批注 list, the highlights, the count on the toolbar, the banner
/// while Alfred revises and the offer to undo a revision. Everything here is pure, so it is tested without a screen.
enum AnnotationPresentation {
    // MARK: The list

    enum SectionKind: Hashable, CaseIterable {
        case drafts
        case submitted
        case resolved
        case returned
        /// Drafts and submitted passages that do not fit the version shown.
        case misfit

        var title: String {
            switch self {
            case .drafts: "草稿"
            case .submitted: "修订中"
            case .resolved: "已回复"
            case .returned: "已退回"
            case .misfit: "已失配"
            }
        }
    }

    /// One line of the list: a draft, or an annotation Alfred has.
    struct Row: Identifiable, Equatable {
        enum Source: Equatable {
            case draft(StoredDraft)
            case annotation(Annotation)
        }

        let source: Source

        var id: String {
            switch source {
            case let .draft(draft): draft.id
            case let .annotation(annotation): annotation.id
            }
        }

        var target: AnnotationTarget {
            switch source {
            case let .draft(draft): draft.target
            case let .annotation(annotation): annotation.target
            }
        }

        /// The selected text of a passage.
        var quote: String? {
            if case let .passage(quote, _, _) = target { quote } else { nil }
        }

        var comment: String {
            switch source {
            case let .draft(draft): draft.comment
            case let .annotation(annotation): annotation.comment
            }
        }

        /// Alfred's answer.
        var reply: String? {
            if case let .annotation(annotation) = source { annotation.reply } else { nil }
        }

        /// Why Alfred sent it back: 未回复, 已撤销, 已停止 or 失败.
        var returnReason: String? {
            guard case let .annotation(annotation) = source, annotation.state == .returned else { return nil }
            return annotation.returnReason.map(AnnotationPresentation.returnReasonLabel) ?? "已退回"
        }

        var isDraft: Bool {
            if case .draft = source { true } else { false }
        }
    }

    struct Section: Identifiable, Equatable {
        let kind: SectionKind
        let rows: [Row]

        var id: SectionKind { kind }
        var title: String { kind.title }
    }

    /// The sections of the 批注 list, the empty ones left out. `fits` says whether a target fits the version shown (a
    /// whole-document comment always does). Drafts are in the order they were written; submitted annotations too; answered and
    /// returned ones are newest first. Drafts and submitted passages that do not fit are listed apart, the drafts first.
    static func sections(drafts: [StoredDraft], annotations: [Annotation], fits: (AnnotationTarget) -> Bool) -> [Section] {
        var rows: [SectionKind: [Row]] = [:]
        for draft in drafts {
            rows[fits(draft.target) ? .drafts : .misfit, default: []].append(Row(source: .draft(draft)))
        }
        let oldestFirst = annotations.sorted { ($0.createdAt, $0.id) < ($1.createdAt, $1.id) }
        for annotation in oldestFirst where annotation.state == .submitted {
            rows[fits(annotation.target) ? .submitted : .misfit, default: []].append(Row(source: .annotation(annotation)))
        }
        for annotation in oldestFirst.reversed() {
            if annotation.state == .resolved {
                rows[.resolved, default: []].append(Row(source: .annotation(annotation)))
            } else if annotation.state == .returned {
                rows[.returned, default: []].append(Row(source: .annotation(annotation)))
            }
        }
        return SectionKind.allCases.compactMap { kind in
            rows[kind].map { Section(kind: kind, rows: $0) }
        }
    }

    static func returnReasonLabel(_ reason: AnnotationReturnReason) -> String {
        switch reason {
        case .unanswered: "未回复"
        case .undone: "已撤销"
        case .stopped: "已停止"
        case .failed: "失败"
        default: reason.rawValue
        }
    }

    static func stateLabel(_ state: AnnotationState) -> String {
        switch state {
        case .submitted: "修订中"
        case .resolved: "已回复"
        case .returned: "已退回"
        default: state.rawValue
        }
    }

    static func highlightLabel(_ kind: PassageHighlight.Kind) -> String {
        switch kind {
        case .draft: "草稿"
        case .submitted: "修订中"
        }
    }

    /// The number on the toolbar's 批注 button: the drafts and the annotations still with Alfred.
    static func openCount(drafts: [StoredDraft], annotations: [Annotation]) -> Int {
        drafts.count + annotations.filter { $0.state == .submitted }.count
    }

    /// The annotations of a document: what a request returned and what the stream told since, each in its latest
    /// version (by `updatedAt`).
    static func merged(loaded: [Annotation], streamed: [Annotation]) -> [Annotation] {
        var byId: [String: Annotation] = [:]
        for annotation in loaded + streamed {
            if let known = byId[annotation.id], known.updatedAt > annotation.updatedAt { continue }
            byId[annotation.id] = annotation
        }
        return Array(byId.values)
    }

    // MARK: Highlights

    /// What to paint in each piece: the drafts, and the annotations that are submitted, whose passages fit the version shown
    /// (`placement` says where). By position within a piece.
    static func highlights(
        drafts: [StoredDraft],
        annotations: [Annotation],
        placement: (AnnotationTarget) -> AnchorText.Placement?
    ) -> [AnchorText.Piece: [PassageHighlight]] {
        var found: [AnchorText.Piece: [PassageHighlight]] = [:]
        func add(_ id: String, _ kind: PassageHighlight.Kind, _ target: AnnotationTarget) {
            guard let placed = placement(target) else { return }
            found[placed.piece, default: []].append(PassageHighlight(id: id, kind: kind, range: placed.range))
        }
        for draft in drafts {
            add(draft.id, .draft, draft.target)
        }
        for annotation in annotations where annotation.state == .submitted {
            add(annotation.id, .submitted, annotation.target)
        }
        return found.mapValues { $0.sorted { $0.range.location < $1.range.location } }
    }

    // MARK: Submitting

    /// The button that submits a batch of `count` drafts.
    static func submitTitle(count: Int) -> String {
        "提交 \(count) 条批注"
    }

    // MARK: While Alfred revises

    /// The strip over a document while a revision run of it is queued or running, and the run its 停止 stops.
    struct RevisionBanner: Equatable {
        let runId: String
        let title: String
        let isRunning: Bool
    }

    /// The banner for a document, from its runs (the detail's merged with the stream's): none when no revision run of it is
    /// queued or running. A run that is running shows before one that waits.
    static func revisionBanner(runs: [Run], documentId: String) -> RevisionBanner? {
        let live = runs.filter { run in
            run.kind == .revision && run.documentId == documentId && (run.status == .queued || run.status == .running)
        }
        let newestFirst = live.sorted { ($0.startedAt, $0.id) > ($1.startedAt, $1.id) }
        if let running = newestFirst.first(where: { $0.status == .running }) {
            return RevisionBanner(runId: running.id, title: "Alfred 正在修订", isRunning: true)
        }
        return newestFirst.first.map { RevisionBanner(runId: $0.id, title: "排队修订中", isRunning: false) }
    }

    // MARK: Undo

    /// The offer to undo a revision: the run that made the document's current version.
    struct UndoOffer: Equatable {
        let runId: String
        /// When the version was made.
        let at: Date

        /// The confirmation's question, which names the version's time.
        var question: String {
            "撤销 \(RunPresentation.dateTime(at)) 的这次修订？"
        }
    }

    /// The menu offers an undo only when the document's current version is a revision. `versions` are the detail's.
    static func undoOffer(currentVersion: String, versions: [DocumentVersion]) -> UndoOffer? {
        guard let version = versions.first(where: { $0.version == currentVersion }), version.reason == .revised, let runId = version.runId else {
            return nil
        }
        return UndoOffer(runId: runId, at: version.at)
    }
}
