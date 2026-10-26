import AlfredKit
import Foundation
import XCTest

@testable import Alfred

/// A model on a fake Alfred for the attachment and question tests: uploads are answered by file name, commands and
/// the event stream by their own scripts, and every request is logged by the server.
@MainActor
struct ChatTestBed {
    let model: AppModel
    let server: StubServer

    /// The requests to one path, in arrival order.
    func requests(to path: String) -> [LoggedRequest] {
        server.requests(to: path)
    }

    /// The names of the files uploaded so far, in arrival order.
    var uploadedNames: [String] {
        requests(to: "/api/uploads").compactMap(\.chatUploadName)
    }

    /// The bodies of the commands sent so far, in arrival order.
    var commands: [[String: Any]] {
        requests(to: "/api/commands").compactMap(\.chatCommand)
    }
}

/// A paired model on a fake server. `uploads` scripts the replies for a file name (a name without a script is saved
/// under `inbox/2026-10-26/<name>`), `commands` and `events` script their paths; the defaults are 202 and an
/// event stream that stays open.
@MainActor
func makeChatTestBed(
    uploads: [String: [StubReply]] = [:],
    commands: [StubReply] = [StubReply(status: 202)],
    events: [StubReply] = [.stream()],
    test: XCTestCase
) throws -> ChatTestBed {
    let uploadScripts = uploads.mapValues(ReplyScript.init)
    let commandScript = ReplyScript(commands)
    let eventScript = ReplyScript(events)
    let server = StubServer { request in
        switch request.url?.path ?? "" {
        case "/api/ping": return StubReply(status: 204)
        case "/api/commands": return commandScript.next()
        case "/api/events": return eventScript.next()
        case "/api/uploads":
            let name = request.url.flatMap { URLComponents(url: $0, resolvingAgainstBaseURL: false) }?
                .queryItems?.first { $0.name == "name" }?.value ?? "unnamed"
            return uploadScripts[name]?.next() ?? chatUploadReply(name: name)
        default: return StubReply(status: 404)
        }
    }
    var counter = 0
    let model = AppModel(store: InMemoryCredentialStore(try server.credentials()), session: server.session) {
        counter += 1
        return "c-test-\(counter)"
    }
    // The server unregisters its handler when it goes, so it stays until the test is over.
    test.addTeardownBlock { @MainActor in
        model.background()
        withExtendedLifetime(server) {}
    }
    return ChatTestBed(model: model, server: server)
}

/// What Alfred answers an upload with: 201 and the file's path in today's inbox.
func chatUploadReply(name: String) -> StubReply {
    let kind = name.hasSuffix(".jpg") || name.hasSuffix(".png") ? "image" : "file"
    let body = #"{"file":{"path":"inbox/2026-10-26/\#(name)","kind":"\#(kind)"}}"#
    return StubReply(status: 201, chunks: [Data(body.utf8)])
}

extension LoggedRequest {
    /// The body of a `POST /api/commands`, as JSON with any value type.
    var chatCommand: [String: Any]? {
        (try? JSONSerialization.jsonObject(with: body)) as? [String: Any]
    }

    /// The `name` an upload was sent under.
    var chatUploadName: String? {
        request.url.flatMap { URLComponents(url: $0, resolvingAgainstBaseURL: false) }?
            .queryItems?.first { $0.name == "name" }?.value
    }
}

/// A directory for a test's files, removed when the test is over.
func makeChatScratchDirectory(for test: XCTestCase) throws -> URL {
    let directory = FileManager.default.temporaryDirectory.appending(path: "chat-test-" + UUID().uuidString, directoryHint: .isDirectory)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    test.addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
    return directory
}

/// A small file in `directory`.
func makeChatFile(_ name: String, in directory: URL, bytes: Int = 64) throws -> URL {
    let url = directory.appending(path: name)
    try Data((0..<bytes).map { UInt8($0 % 251) }).write(to: url)
    return url
}

/// One stored event framed as the server sends it.
func chatFrame(id: Int, type: String, data: [String: Any]) -> Data {
    let event: [String: Any] = ["id": id, "at": "2026-10-26T08:30:00.000Z", "type": type, "data": data]
    let json = (try? JSONSerialization.data(withJSONObject: event, options: [.sortedKeys])) ?? Data()
    return Data("id: \(id)\ndata: \(String(decoding: json, as: UTF8.self))\n\n".utf8)
}

/// A `question.asked` event with the given questions, each `(text, options, multiSelect)`.
func questionAskedFrame(id: Int, questionId: String, runId: String = "cccccc", questions: [(String, [String], Bool)]) -> Data {
    let asked: [[String: Any]] = questions.map { text, options, multiSelect in
        [
            "question": text,
            "header": "问题",
            "options": options.map { ["label": $0, "description": "选 \($0)"] },
            "multiSelect": multiSelect,
        ]
    }
    return chatFrame(id: id, type: "question.asked", data: ["id": questionId, "runId": runId, "questions": asked])
}

/// A `question.answered` event.
func questionAnsweredFrame(id: Int, questionId: String, runId: String = "cccccc", answers: [String: String], cancelled: Bool = false) -> Data {
    var data: [String: Any] = ["id": questionId, "runId": runId, "answers": answers]
    if cancelled { data["cancelled"] = true }
    return chatFrame(id: id, type: "question.answered", data: data)
}
