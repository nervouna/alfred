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

    /// `version` is the one a message delivered; without it the screen opens on the current version.
    init(documentId: String, version: String? = nil) {
        self.documentId = documentId
        _selected = State(initialValue: version)
        _fromMessage = State(initialValue: version != nil)
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

    var body: some View {
        VStack(spacing: 0) {
            if let banner {
                VersionBanner(banner: banner) { showCurrent() }
            }
            if let failure, document != nil, detail == nil {
                Label(failure, systemImage: "exclamationmark.triangle")
                    .font(.footnote)
                    .foregroundStyle(.red)
                    .padding(8)
            }
            content
        }
        .navigationTitle(document?.title ?? "文档")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
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
        }
        .sheet(isPresented: $showsVersions) {
            if let document {
                DocumentVersionsView(
                    rows: DocumentPresentation.rows(of: versions),
                    shown: selected ?? document.version,
                    select: select
                )
            }
        }
        .task { await load() }
        .onChange(of: document?.version) {
            Task { await load() }
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

    private func select(_ row: DocumentPresentation.VersionRow) {
        selected = row.isCurrent ? nil : row.version
        fromMessage = false
    }

    private func showCurrent() {
        selected = nil
        fromMessage = false
    }

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
