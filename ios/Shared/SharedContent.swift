import Foundation
import UniformTypeIdentifiers

/// What the owner shares with Alfred: one web page, or one file the extension holds a copy of.
enum SharedContent: Equatable, Sendable {
    case page(url: URL, title: String?)
    case file(StagedShareFile)
}

/// A file the extension copied into its own scratch area, ready to upload from where it is.
struct StagedShareFile: Equatable, Sendable {
    let url: URL
    /// The name it is uploaded under.
    let name: String
    let contentType: String

    var isImage: Bool {
        contentType.hasPrefix("image/")
    }

    /// Deletes the copy.
    func discard() {
        ShareScratch.removeFolder(of: url)
    }
}

/// Why something shared cannot be sent. `message` is what the owner reads.
enum ShareError: Error, Equatable {
    case unsupported
    case tooLarge(name: String)
    case unreadable(name: String)

    var message: String {
        switch self {
        case .unsupported: "只能分享网页、PDF 或图片"
        case let .tooLarge(name): "「\(name)」超过 50 MB，无法发送"
        case let .unreadable(name): "无法读取「\(name)」"
        }
    }
}

/// The extension's own copies of what it is sending. An extension's memory is small, so a file is copied by the file
/// system (never read into memory) and uploaded from the copy.
enum ShareScratch {
    static let root = FileManager.default.temporaryDirectory.appending(path: "share", directoryHint: .isDirectory)

    /// A new folder to hold one staged file.
    static func newFolder() throws -> URL {
        let folder = root.appending(path: UUID().uuidString, directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        return folder
    }

    /// Deletes the folder of a staged file, if it is one of the scratch area's own: never the directory of a file that
    /// was not staged.
    static func removeFolder(of file: URL) {
        let folder = file.deletingLastPathComponent()
        guard folder.deletingLastPathComponent().standardizedFileURL == root.standardizedFileURL else { return }
        try? FileManager.default.removeItem(at: folder)
    }
}

/// Reads what a host app handed the extension. The activation rule lets exactly one item through, with exactly one
/// URL, PDF or image attachment, so the first match is the one.
@MainActor
enum SharedContentLoader {
    /// A PDF is a file, an image is a file (a format Claude cannot read becomes a JPEG), and any other URL is a page.
    /// The kinds are checked in that order, because a file shared from Files can be both a file URL and a PDF.
    static func load(from items: [NSExtensionItem]) async throws -> SharedContent {
        guard let item = items.first else { throw ShareError.unsupported }
        let providers = item.attachments ?? []
        if let provider = providers.first(where: { $0.hasItemConformingToTypeIdentifier(UTType.pdf.identifier) }) {
            return try await stage(provider, as: .pdf)
        }
        if let provider = providers.first(where: { $0.hasItemConformingToTypeIdentifier(UTType.image.identifier) }) {
            return try await stage(provider, as: .image)
        }
        if let provider = providers.first(where: { $0.hasItemConformingToTypeIdentifier(UTType.url.identifier) }) {
            let url = try await webAddress(in: provider)
            return .page(url: url, title: title(of: item, for: url))
        }
        throw ShareError.unsupported
    }

    // MARK: A web page

    /// The URL the provider holds, when it is a web address.
    private static func webAddress(in provider: NSItemProvider) async throws -> URL {
        try await withCheckedThrowingContinuation { continuation in
            _ = provider.loadObject(ofClass: URL.self) { url, error in
                continuation.resume(with: Result {
                    if let error { throw error }
                    guard let url, ["http", "https"].contains(url.scheme?.lowercased()) else { throw ShareError.unsupported }
                    return url
                })
            }
        }
    }

    /// The page's title as the host app gives it: Safari puts it in the item's title or its content text. A text that is
    /// only the address is no title.
    private static func title(of item: NSExtensionItem, for url: URL) -> String? {
        for candidate in [item.attributedTitle?.string, item.attributedContentText?.string] {
            let text = candidate?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if !text.isEmpty, text != url.absoluteString { return text }
        }
        return nil
    }

    // MARK: A file

    /// Copies the provider's file into the scratch area, or for an image in a format Claude cannot read, writes a JPEG
    /// there. The provider's own file goes when the completion handler returns, so the copy happens inside it.
    private static func stage(_ provider: NSItemProvider, as kind: UTType) async throws -> SharedContent {
        let typeIdentifier = chosenType(of: provider, kind: kind)
        let suggested = provider.suggestedName
        let file: StagedShareFile = try await withCheckedThrowingContinuation { continuation in
            provider.loadFileRepresentation(forTypeIdentifier: typeIdentifier) { source, error in
                continuation.resume(with: Result {
                    guard let source else { throw error ?? ShareError.unreadable(name: suggested ?? "文件") }
                    return try copy(source, typeIdentifier: typeIdentifier, suggestedName: suggested)
                })
            }
        }
        return .file(file)
    }

    /// The type to load. For an image, one Claude reads when the provider offers it, so nothing needs converting.
    private static func chosenType(of provider: NSItemProvider, kind: UTType) -> String {
        let matching = provider.registeredTypeIdentifiers.filter { UTType($0)?.conforms(to: kind) == true }
        if kind == .image, let readable = matching.first(where: { !PhotoExport.needsJPEG(UTType($0)) }) {
            return readable
        }
        return matching.first ?? kind.identifier
    }

    private nonisolated static func copy(_ source: URL, typeIdentifier: String, suggestedName: String?) throws -> StagedShareFile {
        let type = UTType(typeIdentifier)
        let name = fileName(of: source, suggested: suggestedName, type: type)
        guard let size = try? source.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey]), size.isRegularFile == true,
              let bytes = size.fileSize
        else { throw ShareError.unreadable(name: name) }
        // Refused before it is copied: a file this big is not worth the copy.
        guard Int64(bytes) <= AttachmentLimits.maxBytes else { throw ShareError.tooLarge(name: name) }

        let folder = try ShareScratch.newFolder()
        do {
            let staged: URL
            if type?.conforms(to: .image) == true, PhotoExport.needsJPEG(type) {
                staged = folder.appending(path: (name as NSString).deletingPathExtension + ".jpg")
                try PhotoExport.writeJPEG(from: source, to: staged)
            } else {
                staged = folder.appending(path: name)
                try FileManager.default.copyItem(at: source, to: staged)
            }
            let stagedBytes = (try staged.resourceValues(forKeys: [.fileSizeKey]).fileSize).map(Int64.init) ?? 0
            guard stagedBytes <= AttachmentLimits.maxBytes else { throw ShareError.tooLarge(name: staged.lastPathComponent) }
            return StagedShareFile(url: staged, name: staged.lastPathComponent, contentType: contentType(of: staged, type: type))
        } catch {
            try? FileManager.default.removeItem(at: folder)
            throw error as? ShareError ?? ShareError.unreadable(name: name)
        }
    }

    /// The name the owner knows the file by. The system hands over its own copy under a generic name ("PDF document.pdf"),
    /// so the name is the provider's suggested one, with the copy's extension when it lacks one of the file's type.
    private nonisolated static func fileName(of source: URL, suggested: String?, type: UTType?) -> String {
        let extensionOfCopy = source.pathExtension.isEmpty ? (type?.preferredFilenameExtension ?? "") : source.pathExtension
        let suggestion = (suggested ?? "").trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: "/", with: "_")
        let base = suggestion.isEmpty ? source.deletingPathExtension().lastPathComponent : suggestion
        if extensionOfCopy.isEmpty { return base }
        if let type, let named = UTType(filenameExtension: (base as NSString).pathExtension), named.conforms(to: type) { return base }
        return base + "." + extensionOfCopy
    }

    private nonisolated static func contentType(of file: URL, type: UTType?) -> String {
        UTType(filenameExtension: file.pathExtension.lowercased())?.preferredMIMEType
            ?? type?.preferredMIMEType
            ?? "application/octet-stream"
    }
}
