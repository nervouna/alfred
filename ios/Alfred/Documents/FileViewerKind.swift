import Foundation

/// Which viewer opens a file, chosen by the extension of its name.
enum FileViewerKind: Hashable {
    case markdown
    case pdf
    case image
    /// Text and data files, in a monospaced view.
    case text
    /// HTML and SVG, which run in the isolated web view.
    case report
    /// Anything else: QuickLook.
    case quickLook

    private static let extensions: [String: FileViewerKind] = {
        var kinds: [String: FileViewerKind] = [:]
        for ext in ["md", "markdown"] { kinds[ext] = .markdown }
        kinds["pdf"] = .pdf
        for ext in ["png", "jpg", "jpeg", "gif", "webp", "heic"] { kinds[ext] = .image }
        for ext in ["txt", "json", "jsonl", "csv", "tsv", "log", "yaml", "yml", "xml", "js", "ts", "py", "sh", "css"] { kinds[ext] = .text }
        for ext in ["html", "htm", "svg"] { kinds[ext] = .report }
        return kinds
    }()

    init(path: String) {
        let name = path.split(separator: "/").last.map(String.init) ?? ""
        // A leading dot starts a hidden file's name; it is not an extension.
        guard let dot = name.lastIndex(of: "."), dot != name.startIndex else {
            self = .quickLook
            return
        }
        self = Self.extensions[name[name.index(after: dot)...].lowercased()] ?? .quickLook
    }

    var symbol: String {
        switch self {
        case .markdown: "doc.richtext"
        case .pdf: "doc.viewfinder"
        case .image: "photo"
        case .text: "doc.plaintext"
        case .report: "chart.bar.doc.horizontal"
        case .quickLook: "doc"
        }
    }
}
