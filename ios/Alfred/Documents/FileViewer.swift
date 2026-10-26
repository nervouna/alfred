import AlfredKit
import SwiftUI
import WebKit

/// A screen that downloads a workspace file and shows it in the viewer its extension picks. It is pushed from a
/// run's files and from a file chip in the chat that names no document. A failed download shows its reason and a retry.
struct FileViewerScreen: View {
    let path: String
    @State private var download = FileDownload()

    var body: some View {
        FileViewer(path: path, download: download)
            .navigationTitle(DocumentPresentation.name(of: path))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if let url = download.loadedURL {
                    ToolbarItem(placement: .topBarTrailing) {
                        ShareLink(item: url)
                            .accessibilityIdentifier("viewer.share")
                    }
                }
            }
    }
}

/// The viewer of one workspace file, at a version or as it is now: it downloads the file into `download`, and shows
/// what the download holds in the viewer the extension picks. For a Markdown file, `previousVersion` names the version
/// to compare with, and the blocks that changed since it are marked. The screen around it owns the download, so its
/// toolbar can share the file.
struct FileViewer: View {
    let path: String
    /// The version to show; `nil` is the file as it is now.
    var version: String?
    /// The version before `version`, for a Markdown file; `nil` marks nothing.
    var previousVersion: String?
    let download: FileDownload
    @Environment(AppModel.self) private var model

    init(path: String, version: String? = nil, previousVersion: String? = nil, download: FileDownload) {
        self.path = path
        self.version = version
        self.previousVersion = previousVersion
        self.download = download
    }

    var body: some View {
        content
            .task(id: FileDownload.Key(path: path, version: version)) {
                await download.ensureLoaded(path: path, version: version, using: model.client)
            }
    }

    @ViewBuilder
    private var content: some View {
        switch download.state {
        case .loading:
            ProgressView()
        case let .failed(reason):
            ContentUnavailableView {
                Label("无法打开文件", systemImage: "exclamationmark.triangle")
            } description: {
                Text(reason)
                    .accessibilityIdentifier("viewer.failure")
            } actions: {
                Button("重试") {
                    Task { await download.load(path: path, version: version, using: model.client) }
                }
                .accessibilityIdentifier("viewer.retry")
            }
        case let .loaded(url):
            FileContent(
                url: url,
                kind: FileViewerKind(path: path),
                comparison: previousVersion.map { Comparison(path: path, version: $0, download: download) }
            )
            // A file of another version is another screen: nothing of the one before it stays.
            .id(url)
        }
    }
}

/// The version a Markdown file is compared with, and the download that holds it.
private struct Comparison {
    let path: String
    let version: String
    let download: FileDownload
}

/// The viewer for a downloaded file.
private struct FileContent: View {
    let url: URL
    let kind: FileViewerKind
    let comparison: Comparison?

    var body: some View {
        switch kind {
        case .markdown:
            MarkdownFile(url: url, comparison: comparison)
        case .pdf:
            PDFFile(url: url)
        case .image:
            ImageFile(url: url)
        case .text:
            TextFile(url: url) { MonospacedText(content: $0) }
        case .report:
            ReportFile(url: url, isSVG: url.pathExtension.lowercased() == "svg")
        case .quickLook:
            QuickLookView(url: url)
        }
    }
}

/// How much of a text file the viewer reads. A file past it shows its start, with a note.
enum FileText {
    static let limit = 256 * 1024

    struct Content: Equatable {
        let text: String
        let isTruncated: Bool
    }

    static func read(_ url: URL, limit: Int = FileText.limit) throws -> Content {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        let data = try handle.read(upToCount: limit + 1) ?? Data()
        return Content(text: String(decoding: data.prefix(limit), as: UTF8.self), isTruncated: data.count > limit)
    }
}

/// A Markdown file as blocks. With a version to compare with, the blocks that changed since it are marked once that
/// version has been fetched; until then, and when it cannot be fetched, the file shows without marks.
private struct MarkdownFile: View {
    let url: URL
    let comparison: Comparison?
    @Environment(AppModel.self) private var model
    @State private var blocks: [MarkdownBlock]?
    @State private var changed: Set<Int> = []
    @State private var failure: String?
    @State private var comparisonFailed = false

    private struct Job: Hashable {
        let url: URL
        let previous: String?
    }

    var body: some View {
        Group {
            if let blocks {
                VStack(spacing: 0) {
                    MarkdownView(blocks: blocks, changed: changed)
                    if comparisonFailed {
                        Text("无法载入上一个版本，没有标出修改")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity)
                            .padding(8)
                            .background(.bar)
                            .accessibilityIdentifier("viewer.comparisonFailure")
                    }
                }
            } else if let failure {
                ContentUnavailableView("无法读取文件", systemImage: "exclamationmark.triangle", description: Text(failure))
            } else {
                ProgressView()
            }
        }
        .task(id: Job(url: url, previous: comparison?.version)) { await load() }
    }

    private func load() async {
        let current: [MarkdownBlock]
        do {
            current = MarkdownDocument.blocks(from: try FileText.read(url).text)
        } catch {
            failure = error.localizedDescription
            return
        }
        blocks = current
        changed = []
        comparisonFailed = false
        guard let comparison else { return }
        do {
            let file = try await comparison.download.file(path: comparison.path, version: comparison.version, using: model.client)
            let previous = MarkdownDocument.blocks(from: try FileText.read(file).text)
            changed = await Task.detached { MarkdownChanges.changedBlockIds(previous: previous, current: current) }.value
        } catch where LoadFailure.isCancellation(error) {
            return
        } catch {
            comparisonFailed = true
        }
    }
}

/// Reads a file's text, then shows it with `content`.
private struct TextFile<Content: View>: View {
    let url: URL
    @ViewBuilder let content: (FileText.Content) -> Content
    @State private var text: FileText.Content?
    @State private var failure: String?

    var body: some View {
        Group {
            if let text {
                content(text)
            } else if let failure {
                ContentUnavailableView("无法读取文件", systemImage: "exclamationmark.triangle", description: Text(failure))
            } else {
                ProgressView()
            }
        }
        .task(id: url) {
            do {
                text = try FileText.read(url)
            } catch {
                failure = error.localizedDescription
            }
        }
    }
}

/// Text and data files: monospaced, selectable and scrollable. UIKit's text view lays out a long file lazily. It is the
/// one piece of text a passage annotation on a text document anchors on.
private struct MonospacedText: View {
    let content: FileText.Content

    var body: some View {
        VStack(spacing: 0) {
            PassageDocumentText(text: content.text)
                .accessibilityIdentifier("viewer.text")
            if content.isTruncated {
                Text("文件较大，只显示开头的 \(FileText.limit / 1024) KB")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity)
                    .padding(8)
                    .background(.bar)
            }
        }
    }
}

/// An HTML or SVG report, in the isolated web view. The rule list has to be compiled before the page may load, and
/// a report whose rules cannot be had is not shown at all.
private struct ReportFile: View {
    let url: URL
    let isSVG: Bool

    private enum Phase {
        case preparing
        case ready(html: String, ruleList: WKContentRuleList)
        case failed(String)
    }

    @State private var phase = Phase.preparing

    var body: some View {
        Group {
            switch phase {
            case .preparing:
                ProgressView()
            case let .ready(html, ruleList):
                ReportWebView(html: html, ruleList: ruleList)
                    .accessibilityIdentifier("viewer.report")
            case let .failed(reason):
                ContentUnavailableView("无法打开这份报告", systemImage: "exclamationmark.triangle", description: Text(reason))
            }
        }
        .task(id: url) { await prepare() }
    }

    private func prepare() async {
        do {
            let file = try FileText.read(url, limit: 16 * 1024 * 1024)
            if file.isTruncated {
                phase = .failed("文件太大，无法在应用里预览，可以用右上角的分享按钮打开")
                return
            }
            let ruleList = try await ReportIsolation.compileRuleList()
            phase = .ready(html: ReportIsolation.document(for: file.text, isSVG: isSVG), ruleList: ruleList)
        } catch {
            phase = .failed(error is ReportIsolation.RuleListUnavailable ? "隔离规则不可用，报告不会打开" : error.localizedDescription)
        }
    }
}
