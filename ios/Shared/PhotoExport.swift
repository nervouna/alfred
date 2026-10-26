import Foundation
import ImageIO
import UniformTypeIdentifiers

/// Which images have to change format before they go to Alfred: the photos the app attaches and the images the Share
/// Extension is handed. Claude reads JPEG, PNG, GIF and WebP, and not HEIC, which is what the photo library usually holds.
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
