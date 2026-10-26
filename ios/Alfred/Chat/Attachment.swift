import AlfredKit
import Foundation
import ImageIO
import UniformTypeIdentifiers

/// What a message may carry: at most 10 files of at most 50 MiB each (Alfred's own limits).
enum AttachmentLimits {
    static let maxCount = 10
    static let maxBytes: Int64 = 50 * 1024 * 1024
}

/// A file the owner attached to a message: chosen, then uploaded when the message is sent.
struct Attachment: Identifiable, Hashable, Sendable {
    enum State: Hashable, Sendable {
        /// Chosen, not uploaded yet.
        case ready
        /// Going up; the fraction sent, from 0 to 1.
        case uploading(Double)
        /// Saved in Alfred's inbox.
        case uploaded(FileRef)
        case failed
    }

    let id: UUID
    /// The name it is uploaded under.
    let name: String
    /// The app's own copy of the file, in the staging area.
    let fileURL: URL
    let contentType: String
    let size: Int64
    let isImage: Bool
    var state: State = .ready
}

/// Where a chosen file comes from.
enum AttachmentInput: Sendable {
    /// A file from the file picker, possibly outside the app's sandbox. It is copied.
    case file(URL)
    /// A photo the app already holds a file of (the photo picker's export). The app takes the file over: it is moved
    /// into the staging area, or turned into a JPEG there and deleted.
    case photo(URL)
}

extension AttachmentInput {
    var url: URL {
        switch self {
        case let .file(url), let .photo(url): url
        }
    }

    /// The name the owner knows it by, for a message about it.
    var name: String {
        url.lastPathComponent
    }
}

/// Why a file was not attached. `message` is what the owner reads.
enum AttachmentRefusal: Error, Hashable, Sendable {
    case tooMany(name: String)
    case tooLarge(name: String)
    case unreadable(name: String)

    var message: String {
        switch self {
        case let .tooMany(name): "最多只能附 \(AttachmentLimits.maxCount) 个文件，「\(name)」没有添加"
        case let .tooLarge(name): "「\(name)」超过 50 MB，没有添加"
        case let .unreadable(name): "无法读取「\(name)」，没有添加"
        }
    }
}

/// Which photos have to change format before they go to Alfred. Claude reads JPEG, PNG, GIF and WebP, and not HEIC,
/// which is what the photo library usually holds.
enum PhotoExport {
    private static let readable: [UTType] = [.jpeg, .png, .gif, .webP]

    /// Whether a photo of this type is exported as a JPEG. A photo of no known type is tried as an image.
    static func needsJPEG(_ type: UTType?) -> Bool {
        guard let type else { return true }
        return !readable.contains { type.conforms(to: $0) }
    }

    static func needsJPEG(fileExtension: String) -> Bool {
        needsJPEG(UTType(filenameExtension: fileExtension.lowercased()))
    }

    /// Writes `source` as a JPEG at `destination`, keeping its orientation and metadata. Throws when ImageIO cannot read
    /// it.
    static func writeJPEG(from source: URL, to destination: URL, quality: Double = 0.9) throws {
        guard let image = CGImageSourceCreateWithURL(source as CFURL, nil), CGImageSourceGetCount(image) > 0,
              let output = CGImageDestinationCreateWithURL(destination as CFURL, UTType.jpeg.identifier as CFString, 1, nil)
        else { throw CocoaError(.fileReadCorruptFile) }
        let options = [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary
        CGImageDestinationAddImageFromSource(output, image, 0, options)
        guard CGImageDestinationFinalize(output) else {
            try? FileManager.default.removeItem(at: destination)
            throw CocoaError(.fileWriteUnknown)
        }
    }
}

/// The app's own copies of the files being attached: made when a file is chosen, deleted when it is removed or
/// its message has arrived. Nothing here touches the main actor.
enum AttachmentStaging {
    private static let root = FileManager.default.temporaryDirectory.appending(path: "attachments", directoryHint: .isDirectory)

    /// Brings a chosen file into the staging area, or throws why it cannot be attached.
    static func stage(_ input: AttachmentInput) throws -> Attachment {
        switch input {
        case let .file(url): try stageFile(url)
        case let .photo(url): try stagePhoto(url)
        }
    }

    /// Deletes the staged copies.
    static func discard(_ attachments: [Attachment]) {
        for attachment in attachments {
            removeFolder(of: attachment.fileURL)
        }
    }

    /// Deletes the file of a photo the app was not going to attach.
    static func discard(_ input: AttachmentInput) {
        guard case let .photo(url) = input else { return }
        try? FileManager.default.removeItem(at: url)
        removeFolder(of: url)
    }

    /// Deletes the folder of a staged file, if it is one of the staging area's own: never the directory of a file
    /// that was not staged.
    private static func removeFolder(of file: URL) {
        let folder = file.deletingLastPathComponent()
        guard folder.deletingLastPathComponent().standardizedFileURL == root.standardizedFileURL else { return }
        try? FileManager.default.removeItem(at: folder)
    }

    /// A new folder to hold one staged file.
    static func newFolder() throws -> URL {
        let folder = root.appending(path: UUID().uuidString, directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        return folder
    }

    private static func stageFile(_ source: URL) throws -> Attachment {
        let name = source.lastPathComponent
        let scoped = source.startAccessingSecurityScopedResource()
        defer { if scoped { source.stopAccessingSecurityScopedResource() } }

        guard let values = try? source.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey]),
              values.isRegularFile == true, let size = values.fileSize
        else { throw AttachmentRefusal.unreadable(name: name) }
        // Refused before it is copied: a file this big is not worth the copy.
        guard Int64(size) <= AttachmentLimits.maxBytes else { throw AttachmentRefusal.tooLarge(name: name) }

        let folder = try newFolder()
        let copy = folder.appending(path: name)
        do {
            try FileManager.default.copyItem(at: source, to: copy)
        } catch {
            try? FileManager.default.removeItem(at: folder)
            throw AttachmentRefusal.unreadable(name: name)
        }
        return attachment(at: copy, name: name, size: Int64(size))
    }

    private static func stagePhoto(_ source: URL) throws -> Attachment {
        let name = source.lastPathComponent
        let folder = try newFolder()
        do {
            let staged: URL
            if PhotoExport.needsJPEG(fileExtension: source.pathExtension) {
                staged = folder.appending(path: source.deletingPathExtension().lastPathComponent + ".jpg")
                try PhotoExport.writeJPEG(from: source, to: staged)
                try? FileManager.default.removeItem(at: source)
            } else {
                staged = folder.appending(path: name)
                try FileManager.default.moveItem(at: source, to: staged)
            }
            let size = (try staged.resourceValues(forKeys: [.fileSizeKey]).fileSize).map(Int64.init) ?? 0
            guard size <= AttachmentLimits.maxBytes else { throw AttachmentRefusal.tooLarge(name: name) }
            removeFolder(of: source)
            return attachment(at: staged, name: staged.lastPathComponent, size: size)
        } catch {
            try? FileManager.default.removeItem(at: folder)
            throw error as? AttachmentRefusal ?? AttachmentRefusal.unreadable(name: name)
        }
    }

    private static func attachment(at url: URL, name: String, size: Int64) -> Attachment {
        let type = UTType(filenameExtension: url.pathExtension.lowercased())
        return Attachment(
            id: UUID(),
            name: name,
            fileURL: url,
            contentType: type?.preferredMIMEType ?? "application/octet-stream",
            size: size,
            isImage: type?.conforms(to: .image) ?? false
        )
    }
}
