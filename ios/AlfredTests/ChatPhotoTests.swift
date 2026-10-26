import ImageIO
import UniformTypeIdentifiers
import XCTest

@testable import Alfred

@MainActor
final class ChatPhotoTests: XCTestCase {
    /// Writes a small picture in `type`; the file is named `name`. `nil` when the system cannot encode `type`.
    private func writePicture(_ name: String, as type: UTType, in directory: URL) throws -> URL? {
        let context = try XCTUnwrap(CGContext(
            data: nil, width: 48, height: 32, bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
        ))
        context.setFillColor(red: 0.2, green: 0.5, blue: 0.9, alpha: 1)
        context.fill(CGRect(x: 0, y: 0, width: 48, height: 32))
        let image = try XCTUnwrap(context.makeImage())
        let url = directory.appending(path: name)
        guard let destination = CGImageDestinationCreateWithURL(url as CFURL, type.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(destination, image, nil)
        return CGImageDestinationFinalize(destination) ? url : nil
    }

    /// The type of the image in a file, read from its content.
    private func imageType(of url: URL) -> String? {
        CGImageSourceCreateWithURL(url as CFURL, nil).flatMap { CGImageSourceGetType($0) as String? }
    }

    // MARK: The choice

    func testPhotosInFormatsClaudeCannotReadBecomeJPEG() {
        for type in [UTType.heic, .heif, .tiff, .bmp, .rawImage] {
            XCTAssertTrue(PhotoExport.needsJPEG(type), type.identifier)
        }
        XCTAssertTrue(PhotoExport.needsJPEG(nil), "a photo of no known type is tried as an image")
    }

    func testPhotosInFormatsClaudeReadsKeepTheirFormat() {
        for type in [UTType.jpeg, .png, .gif, .webP] {
            XCTAssertFalse(PhotoExport.needsJPEG(type), type.identifier)
        }
    }

    func testTheChoiceFollowsTheFileExtension() {
        XCTAssertTrue(PhotoExport.needsJPEG(fileExtension: "HEIC"))
        XCTAssertTrue(PhotoExport.needsJPEG(fileExtension: "heif"))
        XCTAssertFalse(PhotoExport.needsJPEG(fileExtension: "jpeg"))
        XCTAssertFalse(PhotoExport.needsJPEG(fileExtension: "JPG"))
        XCTAssertFalse(PhotoExport.needsJPEG(fileExtension: "png"))
        XCTAssertFalse(PhotoExport.needsJPEG(fileExtension: "webp"))
    }

    // MARK: The export

    func testAHEICPhotoIsAttachedAsAJPEG() async throws {
        let bed = try makeChatTestBed(test: self)
        let directory = try makeChatScratchDirectory(for: self)
        let heic = try XCTUnwrap(try writePicture("IMG_0413.HEIC", as: .heic, in: directory), "this system cannot encode HEIC")
        XCTAssertEqual(imageType(of: heic), UTType.heic.identifier)

        await bed.model.attach([.photo(heic)])

        let photo = try XCTUnwrap(bed.model.draftAttachments.first)
        XCTAssertEqual(photo.name, "IMG_0413.jpg")
        XCTAssertEqual(photo.contentType, "image/jpeg")
        XCTAssertTrue(photo.isImage)
        XCTAssertEqual(imageType(of: photo.fileURL), UTType.jpeg.identifier)
        XCTAssertFalse(FileManager.default.fileExists(atPath: heic.path), "the HEIC original is not kept")
        XCTAssertNil(bed.model.actionFailure)
    }

    func testAPhotoInAnotherUnreadableFormatIsAttachedAsAJPEG() async throws {
        let bed = try makeChatTestBed(test: self)
        let directory = try makeChatScratchDirectory(for: self)
        let tiff = try XCTUnwrap(try writePicture("scan.tiff", as: .tiff, in: directory))

        await bed.model.attach([.photo(tiff)])

        let photo = try XCTUnwrap(bed.model.draftAttachments.first)
        XCTAssertEqual(photo.name, "scan.jpg")
        XCTAssertEqual(photo.contentType, "image/jpeg")
        XCTAssertEqual(imageType(of: photo.fileURL), UTType.jpeg.identifier)
    }

    func testAPhotoInAFormatClaudeReadsIsAttachedAsItIs() async throws {
        let bed = try makeChatTestBed(test: self)
        let directory = try makeChatScratchDirectory(for: self)
        let png = try XCTUnwrap(try writePicture("screenshot.png", as: .png, in: directory))
        let original = try Data(contentsOf: png)

        await bed.model.attach([.photo(png)])

        let photo = try XCTUnwrap(bed.model.draftAttachments.first)
        XCTAssertEqual(photo.name, "screenshot.png")
        XCTAssertEqual(photo.contentType, "image/png")
        XCTAssertEqual(try Data(contentsOf: photo.fileURL), original, "the bytes are not re-encoded")
    }

    func testAPhotoThatCannotBeReadIsRefusedWithItsName() async throws {
        let bed = try makeChatTestBed(test: self)
        let directory = try makeChatScratchDirectory(for: self)
        let broken = try makeChatFile("broken.heic", in: directory)

        await bed.model.attach([.photo(broken)])

        XCTAssertTrue(bed.model.draftAttachments.isEmpty)
        XCTAssertTrue(try XCTUnwrap(bed.model.actionFailure).contains("broken.heic"))
    }

    func testAnImagePickedAsAFileKeepsItsFormat() async throws {
        let bed = try makeChatTestBed(test: self)
        let directory = try makeChatScratchDirectory(for: self)
        let tiff = try XCTUnwrap(try writePicture("scan.tiff", as: .tiff, in: directory))

        await bed.model.attach([.file(tiff)])

        let attached = try XCTUnwrap(bed.model.draftAttachments.first)
        XCTAssertEqual(attached.name, "scan.tiff")
        XCTAssertEqual(attached.contentType, "image/tiff")
        XCTAssertTrue(attached.isImage)
    }

    func testAnUploadedPhotoGoesOutUnderItsJPEGName() async throws {
        let bed = try makeChatTestBed(test: self)
        let directory = try makeChatScratchDirectory(for: self)
        let tiff = try XCTUnwrap(try writePicture("IMG_7.tiff", as: .tiff, in: directory))
        await bed.model.attach([.photo(tiff)])

        await bed.model.sendDraft("这是什么")

        XCTAssertEqual(bed.uploadedNames, ["IMG_7.jpg"])
        XCTAssertEqual(bed.requests(to: "/api/uploads").first?.request.value(forHTTPHeaderField: "Content-Type"), "image/jpeg")
        let body = try XCTUnwrap(bed.requests(to: "/api/uploads").first).body
        XCTAssertEqual(Array(body.prefix(3)), [0xFF, 0xD8, 0xFF], "the uploaded bytes are a JPEG")
    }
}
