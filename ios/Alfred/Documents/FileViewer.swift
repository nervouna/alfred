import AlfredKit
import SwiftUI
import WebKit

/// A screen that downloads a workspace file and shows it in the viewer its extension picks. It is pushed from a
/// run's files, the 文档 list and a file chip in the chat. A failed download shows its reason and a retry.
struct FileViewerScreen: View {
    let path: String
    @Environment(AppModel.self) private var model
    @State private var download = FileDownload()

    var body: some View {
        content
            .navigationTitle(DocumentEntry(path: path, date: .distantPast).name)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if case let .loaded(url) = download.state {
                    ToolbarItem(placement: .topBarTrailing) {
                        ShareLink(item: url)
                            .accessibilityIdentifier("viewer.share")
                    }
                }
            }
            .task {
                if case .loaded = download.state { return }
                await download.load(path: path, using: model.client)
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
                    Task { await download.load(path: path, using: model.client) }
                }
                .accessibilityIdentifier("viewer.retry")
            }
        case let .loaded(url):
            FileContent(url: url, kind: FileViewerKind(path: path))
        }
    }
}

/// The viewer for a downloaded file.
private struct FileContent: View {
    let url: URL
    let kind: FileViewerKind

    var body: some View {
        switch kind {
        case .markdown:
            TextFile(url: url) { MarkdownView(blocks: MarkdownDocument.blocks(from: $0.text)) }
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

/// Text and data files: monospaced, selectable and scrollable. UIKit's text view lays out a long file lazily.
private struct MonospacedText: View {
    let content: FileText.Content

    var body: some View {
        VStack(spacing: 0) {
            MonospacedTextView(text: content.text)
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

private struct MonospacedTextView: UIViewRepresentable {
    let text: String

    func makeUIView(context: Context) -> UITextView {
        let view = UITextView()
        view.isEditable = false
        view.alwaysBounceVertical = true
        view.backgroundColor = .clear
        view.textContainerInset = UIEdgeInsets(top: 12, left: 12, bottom: 12, right: 12)
        let mono = UIFont.monospacedSystemFont(ofSize: UIFont.preferredFont(forTextStyle: .footnote).pointSize, weight: .regular)
        view.font = UIFontMetrics(forTextStyle: .footnote).scaledFont(for: mono)
        view.adjustsFontForContentSizeCategory = true
        view.textColor = .label
        view.text = text
        return view
    }

    func updateUIView(_ view: UITextView, context: Context) {}
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
