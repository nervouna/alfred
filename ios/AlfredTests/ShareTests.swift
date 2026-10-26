import AlfredKit
import ImageIO
import UniformTypeIdentifiers
import XCTest

@testable import Alfred

/// What the Share Extension does with an item, up to the requests it makes. The sheet itself is thin SwiftUI over
/// `ShareModel`, and the extension's keychain sharing is checked on the phone.
@MainActor
final class ShareTests: XCTestCase {
    private let pageURL = URL(string: "https://example.com/post?id=7&lang=zh")!

    /// A share model on a fake Alfred. `uploads` and `commands` script the replies (an upload is saved under
    /// `inbox/2026-10-26/<name>` by default, a command is accepted); `content` is what the extension was handed.
    private func makeBed(
        paired: Bool = true,
        content: SharedContent = .page(url: URL(string: "https://example.com/")!, title: nil),
        uploads: [StubReply]? = nil,
        commands: [StubReply] = [StubReply(status: 202)]
    ) throws -> (model: ShareModel, server: StubServer, loads: LoadCounter) {
        let uploadScript = uploads.map(ReplyScript.init)
        let commandScript = ReplyScript(commands)
        let server = StubServer { request in
            switch request.url?.path ?? "" {
            case "/api/uploads":
                if let uploadScript { return uploadScript.next() }
                let name = request.url.flatMap { URLComponents(url: $0, resolvingAgainstBaseURL: false) }?
                    .queryItems?.first { $0.name == "name" }?.value ?? "unnamed"
                return chatUploadReply(name: name)
            case "/api/commands": return commandScript.next()
            default: return StubReply(status: 404)
            }
        }
        let loads = LoadCounter()
        var counter = 0
        let model = ShareModel(
            store: InMemoryCredentialStore(paired ? try server.credentials() : nil),
            session: server.session,
            loader: {
                loads.count += 1
                return content
            },
            makeClientId: {
                counter += 1
                return "c-share-\(counter)"
            }
        )
        addTeardownBlock { withExtendedLifetime(server) {} }
        return (model, server, loads)
    }

    @MainActor
    final class LoadCounter {
        var count = 0
    }

    private func stagedFile(_ name: String, contentType: String, bytes: Data = Data("%PDF-1.4 example".utf8)) throws -> StagedShareFile {
        let directory = try makeChatScratchDirectory(for: self)
        let url = directory.appending(path: name)
        try bytes.write(to: url)
        return StagedShareFile(url: url, name: name, contentType: contentType)
    }

    private func commands(_ server: StubServer) -> [[String: Any]] {
        server.requests(to: "/api/commands").compactMap(\.chatCommand)
    }

    // MARK: Without a pairing

    func testWithoutCredentialsTheSheetAsksForPairingAndLoadsNothing() async throws {
        let (model, server, loads) = try makeBed(paired: false)
        XCTAssertEqual(model.phase, .loading)

        await model.start()

        XCTAssertEqual(model.phase, .needsPairing)
        XCTAssertEqual(loads.count, 0, "nothing is read from the shared item")
        XCTAssertFalse(model.canSend)
        await model.send()
        XCTAssertTrue(server.log.isEmpty)
    }

    func testPairedCredentialsLoadTheItem() async throws {
        let (model, _, loads) = try makeBed(content: .page(url: pageURL, title: "标题"))
        await model.start()
        XCTAssertEqual(model.phase, .ready)
        XCTAssertEqual(model.content, .page(url: pageURL, title: "标题"))
        XCTAssertEqual(loads.count, 1)
        XCTAssertTrue(model.canSend)
    }

    func testAnItemThatCannotBeLoadedShowsWhyAndCannotBeSent() async throws {
        let server = StubServer { _ in StubReply(status: 404) }
        let model = ShareModel(
            store: InMemoryCredentialStore(try server.credentials()),
            session: server.session,
            loader: { throw ShareError.unsupported },
            makeClientId: { "c-share-1" }
        )
        await model.start()
        XCTAssertEqual(model.phase, .failed(ShareError.unsupported.message))
        XCTAssertFalse(model.canSend)
        await model.send()
        XCTAssertTrue(server.log.isEmpty)
    }

    // MARK: A web page

    func testAPageWithATitleAndANoteIsOneMessage() async throws {
        let (model, server, _) = try makeBed(content: .page(url: pageURL, title: "一篇文章"))
        await model.start()
        model.note = "  帮我读一下  \n"

        await model.send()

        XCTAssertEqual(model.phase, .sent)
        XCTAssertTrue(server.requests(to: "/api/uploads").isEmpty, "a page uploads nothing")
        let sent = commands(server)
        XCTAssertEqual(sent.count, 1)
        let command = try XCTUnwrap(sent.first)
        XCTAssertEqual(command["type"] as? String, "message.send")
        XCTAssertEqual(command["clientId"] as? String, "c-share-1")
        XCTAssertEqual(command["text"] as? String, "帮我读一下\n\n一篇文章\nhttps://example.com/post?id=7&lang=zh")
        XCTAssertNil(command["files"])
    }

    func testAPageWithATitleAndNoNoteIsTheTitleAndTheURL() async throws {
        let (model, server, _) = try makeBed(content: .page(url: pageURL, title: "一篇文章"))
        await model.start()
        await model.send()
        XCTAssertEqual(commands(server).first?["text"] as? String, "一篇文章\nhttps://example.com/post?id=7&lang=zh")
    }

    func testAPageWithoutATitleIsTheURLAfterTheNote() async throws {
        let (model, server, _) = try makeBed(content: .page(url: pageURL, title: nil))
        await model.start()
        model.note = "存一下"
        await model.send()
        XCTAssertEqual(commands(server).first?["text"] as? String, "存一下\n\nhttps://example.com/post?id=7&lang=zh")
    }

    func testAPageWithNeitherIsJustTheURL() async throws {
        let (model, server, _) = try makeBed(content: .page(url: pageURL, title: nil))
        await model.start()
        model.note = "   "
        await model.send()
        XCTAssertEqual(commands(server).first?["text"] as? String, "https://example.com/post?id=7&lang=zh")
    }

    func testALongTitleIsCutSoTheMessageStaysWithinTheLimit() async throws {
        let (model, server, _) = try makeBed(content: .page(url: pageURL, title: String(repeating: "长", count: 500)))
        await model.start()
        await model.send()
        let text = try XCTUnwrap(commands(server).first?["text"] as? String)
        let title = try XCTUnwrap(text.components(separatedBy: "\n").first)
        XCTAssertEqual(title, String(repeating: "长", count: 300) + "…")
    }

    // MARK: A file

    func testAPDFIsUploadedThenSentWithTheFileAndTheNote() async throws {
        let pdf = try stagedFile("paper.pdf", contentType: "application/pdf", bytes: Data("%PDF-1.7 the paper".utf8))
        let (model, server, _) = try makeBed(content: .file(pdf))
        await model.start()
        model.note = "总结一下"

        await model.send()

        XCTAssertEqual(model.phase, .sent)
        XCTAssertEqual(server.log.map(\.path), ["/api/uploads", "/api/commands"], "the upload comes first")
        let upload = try XCTUnwrap(server.requests(to: "/api/uploads").first)
        XCTAssertEqual(upload.chatUploadName, "paper.pdf")
        XCTAssertEqual(upload.request.value(forHTTPHeaderField: "Content-Type"), "application/pdf")
        XCTAssertEqual(upload.request.value(forHTTPHeaderField: "Authorization"), "Bearer EXAMPLE-DEVICE-TOKEN-NOT-REAL-0123456789abc")
        XCTAssertEqual(String(decoding: upload.body, as: UTF8.self), "%PDF-1.7 the paper")
        let command = try XCTUnwrap(commands(server).first)
        XCTAssertEqual(command["type"] as? String, "message.send")
        XCTAssertEqual(command["text"] as? String, "总结一下")
        let files = try XCTUnwrap(command["files"] as? [[String: String]])
        XCTAssertEqual(files, [["path": "inbox/2026-10-26/paper.pdf", "kind": "file"]])
    }

    func testAnImageWithNoNoteIsSentWithAnEmptyText() async throws {
        let image = try stagedFile("photo.png", contentType: "image/png", bytes: Data([0x89, 0x50, 0x4E, 0x47]))
        let (model, server, _) = try makeBed(content: .file(image))
        await model.start()

        await model.send()

        let command = try XCTUnwrap(commands(server).first)
        XCTAssertEqual(command["text"] as? String, "")
        XCTAssertEqual((command["files"] as? [[String: String]])?.first?["path"], "inbox/2026-10-26/photo.png")
        XCTAssertEqual((command["files"] as? [[String: String]])?.first?["kind"], "image")
    }

    // MARK: Trying again

    func testAFailedUploadShowsTheReasonAndSendsNothing() async throws {
        let pdf = try stagedFile("paper.pdf", contentType: "application/pdf")
        let (model, server, _) = try makeBed(content: .file(pdf), uploads: [StubReply(failure: .notConnectedToInternet), chatUploadReply(name: "paper.pdf")])
        await model.start()
        model.note = "总结一下"

        await model.send()

        guard case let .failed(reason) = model.phase else { return XCTFail("expected a failure, got \(model.phase)") }
        XCTAssertTrue(reason.contains("无法连接服务器"), reason)
        XCTAssertTrue(server.requests(to: "/api/commands").isEmpty, "a message that names no file is not sent")
        XCTAssertEqual(model.note, "总结一下", "the note is kept")
        XCTAssertTrue(model.canSend)

        await model.send()
        XCTAssertEqual(model.phase, .sent)
        XCTAssertEqual(server.requests(to: "/api/uploads").count, 2)
        XCTAssertEqual(commands(server).count, 1)
    }

    func testAMessageThatFailedIsSentAgainWithoutUploadingAgain() async throws {
        let pdf = try stagedFile("paper.pdf", contentType: "application/pdf")
        let (model, server, _) = try makeBed(content: .file(pdf), commands: [StubReply(status: 500), StubReply(status: 202)])
        await model.start()

        await model.send()
        guard case .failed = model.phase else { return XCTFail("expected a failure, got \(model.phase)") }

        await model.send()
        XCTAssertEqual(model.phase, .sent)
        XCTAssertEqual(server.requests(to: "/api/uploads").count, 1, "the file is saved already")
        let sent = commands(server)
        XCTAssertEqual(sent.count, 2)
        XCTAssertEqual(sent.map { $0["clientId"] as? String }, ["c-share-1", "c-share-1"], "a message that did arrive is not stored twice")
        XCTAssertEqual(sent.map { ($0["files"] as? [[String: String]])?.first?["path"] }, ["inbox/2026-10-26/paper.pdf", "inbox/2026-10-26/paper.pdf"])
    }

    func testAFailedPageIsSentAgainWithTheSameClientId() async throws {
        let (model, server, _) = try makeBed(content: .page(url: pageURL, title: nil), commands: [StubReply(failure: .timedOut), StubReply(status: 202)])
        await model.start()
        await model.send()
        guard case .failed = model.phase else { return XCTFail("expected a failure, got \(model.phase)") }
        await model.send()
        XCTAssertEqual(model.phase, .sent)
        XCTAssertEqual(commands(server).map { $0["clientId"] as? String }, ["c-share-1", "c-share-1"])
    }

    func testTheReasonSaysWhatWentWrong() async throws {
        let cases: [(StubReply, String)] = [
            (StubReply(status: 401), "重新配对"),
            (StubReply(status: 403), "Cloudflare Access"),
            (StubReply(status: 413, chunks: [Data(#"{"error":"upload is over 52428800 bytes"}"#.utf8)]), "upload is over 52428800 bytes"),
            (StubReply(status: 502), "502"),
        ]
        for (reply, fragment) in cases {
            let (model, _, _) = try makeBed(commands: [reply])
            await model.start()
            await model.send()
            guard case let .failed(reason) = model.phase else { return XCTFail("expected a failure for \(fragment), got \(model.phase)") }
            XCTAssertTrue(reason.contains(fragment), "\(reason) should mention \(fragment)")
        }
    }

    func testSendingTwiceAtOnceSendsOnce() async throws {
        let (model, server, _) = try makeBed()
        await model.start()
        async let first: Void = model.send()
        async let second: Void = model.send()
        _ = await (first, second)
        XCTAssertEqual(commands(server).count, 1)
    }

    // MARK: Cleaning up

    func testTheStagedCopyIsDeletedOnceSentAndOnDiscard() async throws {
        let first = try stageInScratch("a.pdf")
        let (model, _, _) = try makeBed(content: .file(first))
        await model.start()
        await model.send()
        XCTAssertEqual(model.phase, .sent)
        XCTAssertFalse(FileManager.default.fileExists(atPath: first.url.path))

        let second = try stageInScratch("b.pdf")
        let (other, _, _) = try makeBed(content: .file(second))
        await other.start()
        other.discard()
        XCTAssertFalse(FileManager.default.fileExists(atPath: second.url.path))
    }

    func testAFileThatIsNotInTheScratchAreaIsNeverDeleted() async throws {
        let outside = try stagedFile("keep.pdf", contentType: "application/pdf")
        let (model, _, _) = try makeBed(content: .file(outside))
        await model.start()
        await model.send()
        XCTAssertTrue(FileManager.default.fileExists(atPath: outside.url.path))
    }

    /// A file in the extension's own scratch area, as the loader leaves it.
    private func stageInScratch(_ name: String) throws -> StagedShareFile {
        let folder = try ShareScratch.newFolder()
        let url = folder.appending(path: name)
        try Data("%PDF-1.4 example".utf8).write(to: url)
        addTeardownBlock { try? FileManager.default.removeItem(at: folder) }
        return StagedShareFile(url: url, name: name, contentType: "application/pdf")
    }
}

/// Turning what a host app hands the extension into a `SharedContent`.
@MainActor
final class SharedContentLoaderTests: XCTestCase {
    private func item(_ providers: [NSItemProvider], title: String? = nil, text: String? = nil) -> NSExtensionItem {
        let item = NSExtensionItem()
        item.attachments = providers
        item.attributedTitle = title.map(NSAttributedString.init(string:))
        item.attributedContentText = text.map(NSAttributedString.init(string:))
        return item
    }

    /// A provider for a file, as a host app makes one: it knows the file's name, without the extension.
    private func fileProvider(_ url: URL, named suggested: String?) throws -> NSItemProvider {
        let provider = try XCTUnwrap(NSItemProvider(contentsOf: url))
        provider.suggestedName = suggested
        return provider
    }

    private func urlProvider(_ text: String) -> NSItemProvider {
        NSItemProvider(object: URL(string: text)! as NSURL)
    }

    /// Writes a small picture in `type`. `nil` when the system cannot encode `type`.
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

    private func imageType(of url: URL) -> String? {
        CGImageSourceCreateWithURL(url as CFURL, nil).flatMap { CGImageSourceGetType($0) as String? }
    }

    /// The staged file in `content`, which is cleaned up when the test ends.
    private func staged(_ content: SharedContent) throws -> StagedShareFile {
        guard case let .file(file) = content else {
            XCTFail("expected a file, got \(content)")
            throw ShareError.unsupported
        }
        addTeardownBlock { file.discard() }
        return file
    }

    // MARK: A web page

    func testAURLIsAPageWithTheTitleOfTheItem() async throws {
        let content = try await SharedContentLoader.load(from: [item([urlProvider("https://example.com/a?b=1")], title: "  一篇文章 \n")])
        XCTAssertEqual(content, .page(url: URL(string: "https://example.com/a?b=1")!, title: "一篇文章"))
    }

    func testTheTitleFallsBackToTheContentText() async throws {
        let content = try await SharedContentLoader.load(from: [item([urlProvider("https://example.com/")], text: "Example Domain")])
        XCTAssertEqual(content, .page(url: URL(string: "https://example.com/")!, title: "Example Domain"))
    }

    func testAPageWithNoUsableTitleHasNone() async throws {
        let content = try await SharedContentLoader.load(from: [item([urlProvider("http://example.com/")], title: "  ", text: "")])
        XCTAssertEqual(content, .page(url: URL(string: "http://example.com/")!, title: nil))
    }

    func testOnlyWebAddressesArePages() async throws {
        for text in ["mailto:a@example.com", "tel:123", "file:///private/var/mobile/note.txt", "ftp://example.com/x"] {
            do {
                let content = try await SharedContentLoader.load(from: [item([urlProvider(text)])])
                XCTFail("\(text) should not be shared, got \(content)")
            } catch {
                XCTAssertEqual(error as? ShareError, .unsupported, text)
            }
        }
    }

    func testTextAloneIsNotShared() async throws {
        let provider = NSItemProvider(object: "hello" as NSString)
        do {
            let content = try await SharedContentLoader.load(from: [item([provider])])
            XCTFail("text should not be shared, got \(content)")
        } catch {
            XCTAssertEqual(error as? ShareError, .unsupported)
        }
    }

    func testNothingIsNotShared() async throws {
        do {
            _ = try await SharedContentLoader.load(from: [])
            XCTFail("an empty share should fail")
        } catch {
            XCTAssertEqual(error as? ShareError, .unsupported)
        }
    }

    // MARK: A PDF

    func testAPDFIsCopiedIntoTheScratchAreaUnderItsName() async throws {
        let directory = try makeChatScratchDirectory(for: self)
        let original = directory.appending(path: "My Paper.pdf")
        try Data("%PDF-1.7 the paper".utf8).write(to: original)
        let provider = try fileProvider(original, named: "My Paper")

        let file = try staged(try await SharedContentLoader.load(from: [item([provider])]))

        XCTAssertEqual(file.name, "My Paper.pdf")
        XCTAssertEqual(file.contentType, "application/pdf")
        XCTAssertNotEqual(file.url, original, "the extension works on its own copy")
        XCTAssertEqual(try Data(contentsOf: file.url), Data("%PDF-1.7 the paper".utf8))
        XCTAssertEqual(file.url.lastPathComponent, "My Paper.pdf")
        XCTAssertTrue(FileManager.default.fileExists(atPath: original.path), "the original stays where it was")
    }

    func testTheSuggestedNameKeepsItsOwnExtension() async throws {
        let directory = try makeChatScratchDirectory(for: self)
        let original = directory.appending(path: "x.pdf")
        try Data("%PDF-1.7".utf8).write(to: original)

        let named = try staged(try await SharedContentLoader.load(from: [item([try fileProvider(original, named: "Report.pdf")])]))
        XCTAssertEqual(named.name, "Report.pdf", "the extension is not doubled")

        let slashed = try staged(try await SharedContentLoader.load(from: [item([try fileProvider(original, named: "a/b")])]))
        XCTAssertEqual(slashed.name, "a_b.pdf", "a slash cannot make a folder")
    }

    func testWithoutASuggestedNameTheCopysOwnNameIsUsed() async throws {
        let directory = try makeChatScratchDirectory(for: self)
        let original = directory.appending(path: "x.pdf")
        try Data("%PDF-1.7".utf8).write(to: original)

        let file = try staged(try await SharedContentLoader.load(from: [item([try fileProvider(original, named: nil)])]))

        XCTAssertTrue(file.name.hasSuffix(".pdf"), file.name)
        XCTAssertEqual(file.url.lastPathComponent, file.name)
    }

    func testAFileOverFiftyMiBIsRefusedByName() async throws {
        let directory = try makeChatScratchDirectory(for: self)
        let big = directory.appending(path: "huge.pdf")
        FileManager.default.createFile(atPath: big.path, contents: nil)
        let handle = try FileHandle(forWritingTo: big)
        try handle.truncate(atOffset: UInt64(AttachmentLimits.maxBytes) + 1)
        try handle.close()
        let provider = try fileProvider(big, named: "huge")

        do {
            let content = try await SharedContentLoader.load(from: [item([provider])])
            XCTFail("a file over the limit should be refused, got \(content)")
        } catch {
            XCTAssertEqual(error as? ShareError, .tooLarge(name: "huge.pdf"))
            XCTAssertTrue((error as? ShareError)?.message.contains("huge.pdf") == true)
        }
    }

    // MARK: An image

    func testAJPEGKeepsItsFormat() async throws {
        let directory = try makeChatScratchDirectory(for: self)
        let jpeg = try XCTUnwrap(try writePicture("beach.jpg", as: .jpeg, in: directory))
        let original = try Data(contentsOf: jpeg)
        let provider = try fileProvider(jpeg, named: "beach")

        let file = try staged(try await SharedContentLoader.load(from: [item([provider])]))

        XCTAssertEqual((file.name as NSString).deletingPathExtension, "beach", "the name the owner knows it by")
        XCTAssertEqual(UTType(filenameExtension: (file.name as NSString).pathExtension), .jpeg)
        XCTAssertEqual(file.contentType, "image/jpeg")
        XCTAssertEqual(try Data(contentsOf: file.url), original, "the bytes are not re-encoded")
    }

    func testAPNGKeepsItsFormat() async throws {
        let directory = try makeChatScratchDirectory(for: self)
        let png = try XCTUnwrap(try writePicture("screenshot.png", as: .png, in: directory))
        let provider = try fileProvider(png, named: "screenshot")

        let file = try staged(try await SharedContentLoader.load(from: [item([provider])]))

        XCTAssertEqual(file.name, "screenshot.png")
        XCTAssertEqual(file.contentType, "image/png")
        XCTAssertEqual(try Data(contentsOf: file.url), try Data(contentsOf: png))
    }

    func testAHEICImageBecomesAJPEG() async throws {
        let directory = try makeChatScratchDirectory(for: self)
        let heic = try XCTUnwrap(try writePicture("IMG_0413.HEIC", as: .heic, in: directory), "this system cannot encode HEIC")
        XCTAssertEqual(imageType(of: heic), UTType.heic.identifier)
        let provider = try fileProvider(heic, named: "IMG_0413")

        let file = try staged(try await SharedContentLoader.load(from: [item([provider])]))

        XCTAssertEqual(file.name, "IMG_0413.jpg")
        XCTAssertEqual(file.contentType, "image/jpeg")
        XCTAssertEqual(file.url.lastPathComponent, "IMG_0413.jpg")
        XCTAssertEqual(imageType(of: file.url), UTType.jpeg.identifier)
        XCTAssertEqual(
            try FileManager.default.contentsOfDirectory(atPath: file.url.deletingLastPathComponent().path),
            ["IMG_0413.jpg"],
            "the HEIC copy is not kept"
        )
        XCTAssertTrue(FileManager.default.fileExists(atPath: heic.path), "the original stays where it was")
    }

    func testAnImageThatCannotBeReadIsRefusedByName() async throws {
        let directory = try makeChatScratchDirectory(for: self)
        let broken = try makeChatFile("broken.heic", in: directory)
        let provider = try fileProvider(broken, named: "broken")
        do {
            let content = try await SharedContentLoader.load(from: [item([provider])])
            XCTFail("an unreadable image should be refused, got \(content)")
        } catch {
            XCTAssertEqual(error as? ShareError, .unreadable(name: "broken.heic"))
        }
    }

    // MARK: Whole path

    func testAHEICImageGoesUpAsAJPEGAndIsSentWithTheNote() async throws {
        let directory = try makeChatScratchDirectory(for: self)
        let heic = try XCTUnwrap(try writePicture("IMG_0413.HEIC", as: .heic, in: directory), "this system cannot encode HEIC")
        let provider = try fileProvider(heic, named: "IMG_0413")
        let shared = item([provider])

        let server = StubServer { request in
            switch request.url?.path ?? "" {
            case "/api/uploads":
                let name = request.url.flatMap { URLComponents(url: $0, resolvingAgainstBaseURL: false) }?
                    .queryItems?.first { $0.name == "name" }?.value ?? "unnamed"
                return chatUploadReply(name: name)
            case "/api/commands": return StubReply(status: 202)
            default: return StubReply(status: 404)
            }
        }
        addTeardownBlock { withExtendedLifetime(server) {} }
        let model = ShareModel(
            store: InMemoryCredentialStore(try server.credentials()),
            session: server.session,
            loader: { try await SharedContentLoader.load(from: [shared]) },
            makeClientId: { "c-share-1" }
        )
        await model.start()
        XCTAssertEqual(model.phase, .ready)
        model.note = "这是什么花"

        await model.send()

        XCTAssertEqual(model.phase, .sent)
        let upload = try XCTUnwrap(server.requests(to: "/api/uploads").first)
        XCTAssertEqual(upload.chatUploadName, "IMG_0413.jpg")
        XCTAssertEqual(upload.request.value(forHTTPHeaderField: "Content-Type"), "image/jpeg")
        XCTAssertEqual(Array(upload.body.prefix(3)), [0xFF, 0xD8, 0xFF], "the uploaded bytes are a JPEG")
        let command = try XCTUnwrap(server.requests(to: "/api/commands").first?.chatCommand)
        XCTAssertEqual(command["text"] as? String, "这是什么花")
        XCTAssertEqual((command["files"] as? [[String: String]])?.first?["path"], "inbox/2026-10-26/IMG_0413.jpg")
    }

    /// The extension is built into the app, and builds its keychain store as the app does, from its own Info.plist.
    func testTheExtensionNamesTheSameKeychainGroupAsTheApp() throws {
        let plugIns = try XCTUnwrap(Bundle.main.builtInPlugInsURL)
        let bundle = try XCTUnwrap(Bundle(url: plugIns.appending(path: "AlfredShare.appex")), "the extension is not built into the app")

        let appGroup = try XCTUnwrap(Bundle.main.object(forInfoDictionaryKey: "AlfredKeychainAccessGroup") as? String)
        let extensionGroup = try XCTUnwrap(bundle.object(forInfoDictionaryKey: "AlfredKeychainAccessGroup") as? String, "the extension's Info.plist has no AlfredKeychainAccessGroup")
        XCTAssertEqual(extensionGroup, appGroup)
        XCTAssertEqual(AppKeychain.store(bundle: bundle).service, "alfred")
        XCTAssertEqual(AppKeychain.store(bundle: bundle).service, AppKeychain.store().service)
    }
}
