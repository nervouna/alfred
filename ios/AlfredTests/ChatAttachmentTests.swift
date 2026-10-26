import AlfredKit
import XCTest

@testable import Alfred

@MainActor
final class ChatAttachmentTests: XCTestCase {
    /// Attaches the files, as the file picker would.
    private func attach(_ names: [String], to bed: ChatTestBed, in directory: URL, bytes: Int = 64) async throws {
        let urls = try names.map { try makeChatFile($0, in: directory, bytes: bytes) }
        await bed.model.attach(urls.map(AttachmentInput.file))
    }

    private func paths(of command: [String: Any]?) -> [String] {
        ((command?["files"] as? [[String: Any]]) ?? []).compactMap { $0["path"] as? String }
    }

    // MARK: Choosing

    func testChosenFilesBecomeChipsInOrderAndCanBeRemoved() async throws {
        let bed = try makeChatTestBed(test: self)
        let directory = try makeChatScratchDirectory(for: self)
        try await attach(["a.pdf", "b.png", "c.txt"], to: bed, in: directory)

        XCTAssertEqual(bed.model.draftAttachments.map(\.name), ["a.pdf", "b.png", "c.txt"])
        XCTAssertEqual(bed.model.draftAttachments.map(\.contentType), ["application/pdf", "image/png", "text/plain"])
        XCTAssertEqual(bed.model.draftAttachments.map(\.isImage), [false, true, false])
        XCTAssertNil(bed.model.actionFailure)

        let removed = try XCTUnwrap(bed.model.draftAttachments.dropFirst().first)
        bed.model.removeAttachment(id: removed.id)
        XCTAssertEqual(bed.model.draftAttachments.map(\.name), ["a.pdf", "c.txt"])
        XCTAssertFalse(FileManager.default.fileExists(atPath: removed.fileURL.path), "a removed chip leaves no staged copy")
    }

    func testAStagedFileIsACopyAndTheOriginalIsLeftAlone() async throws {
        let bed = try makeChatTestBed(test: self)
        let directory = try makeChatScratchDirectory(for: self)
        let original = try makeChatFile("notes.md", in: directory)
        await bed.model.attach([.file(original)])

        let staged = try XCTUnwrap(bed.model.draftAttachments.first)
        XCTAssertNotEqual(staged.fileURL, original)
        XCTAssertEqual(try Data(contentsOf: staged.fileURL), try Data(contentsOf: original))
        bed.model.removeAttachment(id: staged.id)
        XCTAssertTrue(FileManager.default.fileExists(atPath: original.path))
    }

    func testMoreThanTenFilesAreRefused() async throws {
        let bed = try makeChatTestBed(test: self)
        let directory = try makeChatScratchDirectory(for: self)
        let names = (1...11).map { "file-\($0).txt" }
        try await attach(names, to: bed, in: directory)

        XCTAssertEqual(bed.model.draftAttachments.map(\.name), Array(names.prefix(10)))
        let failure = try XCTUnwrap(bed.model.actionFailure)
        XCTAssertTrue(failure.contains("file-11.txt"), failure)
        XCTAssertTrue(failure.contains("10"), failure)

        // A full draft takes nothing more.
        bed.model.actionFailure = nil
        try await attach(["one-more.txt"], to: bed, in: directory)
        XCTAssertEqual(bed.model.draftAttachments.count, 10)
        XCTAssertTrue(try XCTUnwrap(bed.model.actionFailure).contains("one-more.txt"))
    }

    func testAFileOverFiftyMiBIsRefusedWithItsName() async throws {
        let bed = try makeChatTestBed(test: self)
        let directory = try makeChatScratchDirectory(for: self)
        let big = directory.appending(path: "recording.mov")
        let handle = try { () throws -> FileHandle in
            XCTAssertTrue(FileManager.default.createFile(atPath: big.path, contents: nil))
            return try FileHandle(forWritingTo: big)
        }()
        try handle.truncate(atOffset: UInt64(AttachmentLimits.maxBytes) + 1)
        try handle.close()
        let small = try makeChatFile("small.txt", in: directory)

        await bed.model.attach([.file(big), .file(small)])

        XCTAssertEqual(bed.model.draftAttachments.map(\.name), ["small.txt"], "the others are still attached")
        let failure = try XCTUnwrap(bed.model.actionFailure)
        XCTAssertTrue(failure.contains("recording.mov"), failure)
        XCTAssertTrue(failure.contains("50"), failure)
    }

    func testAFileOfExactlyFiftyMiBIsAccepted() async throws {
        let bed = try makeChatTestBed(test: self)
        let directory = try makeChatScratchDirectory(for: self)
        let exact = directory.appending(path: "archive.zip")
        XCTAssertTrue(FileManager.default.createFile(atPath: exact.path, contents: nil))
        let handle = try FileHandle(forWritingTo: exact)
        try handle.truncate(atOffset: UInt64(AttachmentLimits.maxBytes))
        try handle.close()

        await bed.model.attach([.file(exact)])

        XCTAssertEqual(bed.model.draftAttachments.map(\.name), ["archive.zip"])
        XCTAssertEqual(bed.model.draftAttachments.first?.size, AttachmentLimits.maxBytes)
        XCTAssertNil(bed.model.actionFailure)
    }

    func testAFolderIsRefusedWithItsName() async throws {
        let bed = try makeChatTestBed(test: self)
        let directory = try makeChatScratchDirectory(for: self)
        let folder = directory.appending(path: "reports", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)

        await bed.model.attach([.file(folder)])

        XCTAssertTrue(bed.model.draftAttachments.isEmpty)
        XCTAssertTrue(try XCTUnwrap(bed.model.actionFailure).contains("reports"))
    }

    // MARK: Sending

    func testSendingUploadsInOrderThenSendsTheMessageWithTheirFileRefs() async throws {
        let bed = try makeChatTestBed(test: self)
        let directory = try makeChatScratchDirectory(for: self)
        try await attach(["first.pdf", "second.png", "third.txt"], to: bed, in: directory)

        await bed.model.sendDraft("  这几个文件  ")

        XCTAssertEqual(bed.uploadedNames, ["first.pdf", "second.png", "third.txt"])
        let uploads = bed.requests(to: "/api/uploads")
        XCTAssertEqual(uploads.map { $0.request.value(forHTTPHeaderField: "Content-Type") }, ["application/pdf", "image/png", "text/plain"])
        XCTAssertEqual(uploads.map { $0.request.value(forHTTPHeaderField: "Authorization") != nil }, [true, true, true])

        let command = try XCTUnwrap(bed.commands.first)
        XCTAssertEqual(bed.commands.count, 1)
        XCTAssertEqual(command["type"] as? String, "message.send")
        XCTAssertEqual(command["clientId"] as? String, "c-test-1")
        XCTAssertEqual(command["text"] as? String, "这几个文件")
        XCTAssertEqual(paths(of: command), ["inbox/2026-10-26/first.pdf", "inbox/2026-10-26/second.png", "inbox/2026-10-26/third.txt"])
        XCTAssertEqual((command["files"] as? [[String: Any]])?.compactMap { $0["kind"] as? String }, ["file", "image", "file"])

        // Every upload came before the message, in one run of the log.
        let order = bed.server.log.map(\.path).filter { $0 == "/api/uploads" || $0 == "/api/commands" }
        XCTAssertEqual(order, ["/api/uploads", "/api/uploads", "/api/uploads", "/api/commands"])

        XCTAssertTrue(bed.model.draftAttachments.isEmpty, "sending takes the draft's files")
        XCTAssertTrue(bed.model.failedClientIds.isEmpty)
    }

    func testAMessageOfFilesAloneIsSentWithEmptyText() async throws {
        let bed = try makeChatTestBed(test: self)
        let directory = try makeChatScratchDirectory(for: self)
        try await attach(["quote.pdf"], to: bed, in: directory)

        await bed.model.sendDraft("   ")

        let command = try XCTUnwrap(bed.commands.first)
        XCTAssertEqual(command["text"] as? String, "")
        XCTAssertEqual(paths(of: command), ["inbox/2026-10-26/quote.pdf"])
        XCTAssertEqual(bed.model.timeline.pending.count, 1)
        XCTAssertEqual(bed.model.timeline.pending.first?.text, "")
    }

    func testNothingIsSentWithoutTextOrFiles() async throws {
        let bed = try makeChatTestBed(test: self)
        await bed.model.sendDraft("  ")
        XCTAssertTrue(bed.model.timeline.pending.isEmpty)
        XCTAssertTrue(bed.server.log.isEmpty)
    }

    func testAFailedUploadSendsNothingAndTheRetryUploadsOnlyWhatFailed() async throws {
        let bed = try makeChatTestBed(uploads: [
            "second.png": [StubReply(failure: .networkConnectionLost), chatUploadReply(name: "second.png")],
        ], test: self)
        let directory = try makeChatScratchDirectory(for: self)
        try await attach(["first.pdf", "second.png", "third.txt"], to: bed, in: directory)

        await bed.model.sendDraft("三个文件")

        // The others are uploaded; the failed one is marked, and the message is not sent.
        XCTAssertEqual(bed.uploadedNames, ["first.pdf", "second.png", "third.txt"])
        XCTAssertTrue(bed.commands.isEmpty, "a message with a failed upload is not sent")
        let clientId = try XCTUnwrap(bed.model.timeline.pending.first?.clientId)
        XCTAssertEqual(bed.model.failedClientIds, [clientId])
        let states = try XCTUnwrap(bed.model.outgoingAttachments[clientId]).map(\.state)
        XCTAssertEqual(states.count, 3)
        XCTAssertEqual(states[1], .failed)
        for index in [0, 2] {
            guard case .uploaded = states[index] else { return XCTFail("expected an uploaded file at \(index), got \(states[index])") }
        }

        await bed.model.retry(clientId: clientId)

        XCTAssertEqual(bed.uploadedNames, ["first.pdf", "second.png", "third.txt", "second.png"], "only the failed one is uploaded again")
        let command = try XCTUnwrap(bed.commands.first)
        XCTAssertEqual(bed.commands.count, 1)
        XCTAssertEqual(command["clientId"] as? String, clientId, "the retry keeps the client id")
        XCTAssertEqual(command["text"] as? String, "三个文件")
        XCTAssertEqual(paths(of: command), ["inbox/2026-10-26/first.pdf", "inbox/2026-10-26/second.png", "inbox/2026-10-26/third.txt"])
        XCTAssertTrue(bed.model.failedClientIds.isEmpty)
    }

    func testAnUploadTheServerRefusesFailsTheMessageToo() async throws {
        let bed = try makeChatTestBed(uploads: ["huge.bin": [StubReply(status: 413)]], test: self)
        let directory = try makeChatScratchDirectory(for: self)
        try await attach(["huge.bin"], to: bed, in: directory)
        await bed.model.sendDraft("")

        XCTAssertTrue(bed.commands.isEmpty)
        XCTAssertEqual(bed.model.failedClientIds.count, 1)
        let clientId = try XCTUnwrap(bed.model.timeline.pending.first?.clientId)
        XCTAssertEqual(bed.model.outgoingAttachments[clientId]?.first?.state, .failed)
    }

    func testAFailedMessageSendAfterTheUploadsRetriesWithoutUploadingAgain() async throws {
        let bed = try makeChatTestBed(commands: [StubReply(failure: .networkConnectionLost), StubReply(status: 202)], test: self)
        let directory = try makeChatScratchDirectory(for: self)
        try await attach(["a.pdf", "b.txt"], to: bed, in: directory)

        await bed.model.sendDraft("文件")
        let clientId = try XCTUnwrap(bed.model.timeline.pending.first?.clientId)
        XCTAssertEqual(bed.model.failedClientIds, [clientId])
        XCTAssertEqual(bed.uploadedNames, ["a.pdf", "b.txt"])

        await bed.model.retry(clientId: clientId)

        XCTAssertEqual(bed.uploadedNames, ["a.pdf", "b.txt"], "uploaded files are not uploaded again")
        XCTAssertEqual(bed.commands.count, 2)
        XCTAssertEqual(bed.commands.map { $0["clientId"] as? String }, [clientId, clientId])
        XCTAssertEqual(paths(of: bed.commands.last), ["inbox/2026-10-26/a.pdf", "inbox/2026-10-26/b.txt"])
        XCTAssertTrue(bed.model.failedClientIds.isEmpty)
    }

    func testAnAccessErrorOnAnUploadShowsTheAccessFailure() async throws {
        let bed = try makeChatTestBed(uploads: ["a.pdf": [StubReply(status: 401)]], test: self)
        let directory = try makeChatScratchDirectory(for: self)
        try await attach(["a.pdf"], to: bed, in: directory)
        await bed.model.sendDraft("")
        XCTAssertEqual(bed.model.streamFailure, .unauthorized)
    }

    // MARK: The pending message

    func testThePendingMessageShowsItsAttachmentsUntilItsEchoArrives() async throws {
        let echo = chatFrame(id: 1, type: "message.created", data: [
            "id": "m1", "channel": "app", "direction": "in", "text": "文件", "at": "2026-10-26T08:30:00.000Z",
            "files": [["path": "inbox/2026-10-26/a.pdf", "kind": "file"]], "clientId": "c-test-1",
        ])
        let bed = try makeChatTestBed(events: [.stream([echo])], test: self)
        let directory = try makeChatScratchDirectory(for: self)
        try await attach(["a.pdf"], to: bed, in: directory)
        let staged = try XCTUnwrap(bed.model.draftAttachments.first)

        // Foreground only after the send, so the echo cannot arrive before the message is sent.
        await bed.model.sendDraft("文件")
        XCTAssertEqual(bed.model.timeline.pending.map(\.clientId), ["c-test-1"])
        XCTAssertEqual(bed.model.outgoingAttachments["c-test-1"]?.map(\.name), ["a.pdf"])
        XCTAssertTrue(FileManager.default.fileExists(atPath: staged.fileURL.path), "the file stays until the echo")

        bed.model.foreground()
        await eventually { bed.model.timeline.pending.isEmpty }
        XCTAssertNil(bed.model.outgoingAttachments["c-test-1"])
        XCTAssertEqual(bed.model.timeline.messages.first?.files.map(\.path), ["inbox/2026-10-26/a.pdf"])
        XCTAssertFalse(FileManager.default.fileExists(atPath: staged.fileURL.path), "the staged copy goes with the echo")
    }

    func testUnpairingForgetsTheDraftAndTheOutgoingFiles() async throws {
        let bed = try makeChatTestBed(commands: [StubReply(failure: .networkConnectionLost)], test: self)
        let directory = try makeChatScratchDirectory(for: self)
        try await attach(["sent.pdf"], to: bed, in: directory)
        await bed.model.sendDraft("")
        try await attach(["draft.pdf"], to: bed, in: directory)
        let staged = bed.model.draftAttachments + bed.model.outgoingAttachments.values.flatMap { $0 }
        XCTAssertEqual(staged.count, 2)

        bed.model.unpair()

        XCTAssertTrue(bed.model.draftAttachments.isEmpty)
        XCTAssertTrue(bed.model.outgoingAttachments.isEmpty)
        for attachment in staged {
            XCTAssertFalse(FileManager.default.fileExists(atPath: attachment.fileURL.path))
        }
    }
}
