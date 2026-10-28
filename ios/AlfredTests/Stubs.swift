import AlfredKit
import Foundation
import Synchronization
import XCTest

/// One canned answer. Chunks go out in order; `finish: false` leaves the response open, as a stream does.
/// `failure` fails the load with a transport error instead. URLSession hands an open response to its caller only
/// once it has a content type, so every reply carries one.
struct StubReply: Sendable {
    var status = 200
    var headers: [String: String] = ["Content-Type": "application/json"]
    var chunks: [Data] = []
    var finish = true
    var failure: URLError.Code?
}

/// Answers a request with what the handler registered for the request's host returns. Each test registers its
/// handler under a host of its own (see `StubServer`), so a request left over from an earlier test cannot take a
/// reply meant for the running one. A host without a handler gets a 599.
final class StubURLProtocol: URLProtocol {
    typealias Handler = @Sendable (URLRequest) -> StubReply

    private static let handlers = Mutex<[String: Handler]>([:])

    static func register(_ handler: @escaping Handler, forHost host: String) {
        handlers.withLock { $0[host] = handler }
    }

    static func unregister(host: String) {
        handlers.withLock { $0[host] = nil }
    }

    override class func canInit(with request: URLRequest) -> Bool {
        true
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    override func startLoading() {
        let answer = request.url?.host.flatMap { host in StubURLProtocol.handlers.withLock { $0[host] } }
        let reply = answer?(request) ?? StubReply(status: 599)
        if let failure = reply.failure {
            client?.urlProtocol(self, didFailWithError: URLError(failure))
            return
        }
        guard let url = request.url,
              let response = HTTPURLResponse(url: url, statusCode: reply.status, httpVersion: "HTTP/1.1", headerFields: reply.headers)
        else { return }
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        for chunk in reply.chunks {
            client?.urlProtocol(self, didLoad: chunk)
        }
        if reply.finish {
            client?.urlProtocolDidFinishLoading(self)
        }
    }

    override func stopLoading() {}
}

/// A request a stub saw, with its body.
struct LoggedRequest: Sendable {
    let request: URLRequest
    let body: Data

    var path: String { request.url?.path ?? "" }

    /// The body of a `POST /api/commands`, as JSON.
    var command: [String: String]? {
        (try? JSONSerialization.jsonObject(with: body)) as? [String: String]
    }
}

/// The requests a stub saw, in arrival order.
final class RequestBox: Sendable {
    private let items = Mutex<[LoggedRequest]>([])

    func append(_ request: LoggedRequest) {
        items.withLock { $0.append(request) }
    }

    var all: [LoggedRequest] {
        items.withLock { $0 }
    }
}

/// A fake Alfred server for one test: a session whose requests all go to `handler`, a host only this test uses,
/// the requests it saw, and the pairing a user would paste to reach it.
final class StubServer: Sendable {
    let host: String
    let session: URLSession
    private let requests = RequestBox()

    init(handler: @escaping @Sendable (URLRequest) -> StubReply) {
        let host = UUID().uuidString.lowercased() + ".stub.test"
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubURLProtocol.self]
        self.host = host
        session = URLSession(configuration: configuration)
        StubURLProtocol.register({ [requests] request in
            requests.append(LoggedRequest(request: request, body: Self.bodyData(of: request)))
            return handler(request)
        }, forHost: host)
    }

    deinit {
        StubURLProtocol.unregister(host: host)
    }

    var log: [LoggedRequest] {
        requests.all
    }

    func requests(to path: String) -> [LoggedRequest] {
        log.filter { $0.path == path }
    }

    /// The JSON of a pairing for this server, with made-up tokens.
    var pairingJSON: String {
        """
        {"version":1,"server":"https://\(host)","access":{"clientId":"example-service-token.access","clientSecret":"example-client-secret-not-real"},"device":{"id":"k7m2qa","token":"EXAMPLE-DEVICE-TOKEN-NOT-REAL-0123456789abc"}}
        """
    }

    /// The credentials that pairing makes.
    func credentials() throws -> Credentials {
        Credentials(pairing: try JSONDecoder().decode(Pairing.self, from: Data(pairingJSON.utf8)))
    }

    /// The body of a request, whether it was sent from memory or streamed.
    private static func bodyData(of request: URLRequest) -> Data {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return Data() }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 16 * 1024)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            if count <= 0 { break }
            data.append(buffer, count: count)
        }
        return data
    }
}

/// Replies in turn; once the replies run out, the last one repeats.
final class ReplyScript: Sendable {
    private let replies: Mutex<[StubReply]>

    init(_ replies: [StubReply]) {
        self.replies = Mutex(replies)
    }

    func next() -> StubReply {
        replies.withLock { $0.count > 1 ? $0.removeFirst() : ($0.first ?? StubReply(status: 500)) }
    }
}

extension StubReply {
    /// An event stream that stays open after sending `frames` as its backlog, which the server ends with `caught-up`.
    static func stream(_ frames: [Data] = []) -> StubReply {
        StubReply(headers: ["Content-Type": "text/event-stream"], chunks: frames + [Data("event: caught-up\ndata: {}\n\n".utf8)], finish: false)
    }
}

/// One stored `message.created` event as the server frames it.
func messageFrame(
    id: Int,
    direction: String = "out",
    text: String,
    clientId: String? = nil,
    runId: String? = nil
) -> Data {
    var data: [String: Any] = [
        "id": "m\(id)",
        "channel": "app",
        "direction": direction,
        "text": text,
        "files": [Any](),
        "at": "2026-10-25T08:30:00.000Z",
    ]
    if let clientId { data["clientId"] = clientId }
    if let runId { data["runId"] = runId }
    return frame(id: id, event: ["id": id, "at": "2026-10-25T08:30:00.000Z", "type": "message.created", "data": data])
}

/// One stored `run.updated` event as the server frames it. A run of a task names its `taskId`.
func runFrame(
    id: Int,
    runId: String,
    kind: String = "task",
    status: String,
    taskId: String? = nil,
    title: String = "调研",
    startedAt: String = "2026-10-25T08:30:05.000Z"
) -> Data {
    var run: [String: Any] = [
        "id": runId,
        "kind": kind,
        "title": title,
        "status": status,
        "startedAt": startedAt,
        "costUsd": 0,
        "files": [Any](),
    ]
    if let taskId { run["taskId"] = taskId }
    return frame(id: id, event: ["id": id, "at": startedAt, "type": "run.updated", "data": run])
}

/// One stored `task.updated` event as the server frames it.
func taskFrame(id: Int, task: [String: Any]) -> Data {
    frame(id: id, event: ["id": id, "at": "2026-10-25T08:30:00.000Z", "type": "task.updated", "data": task])
}

/// One live `run.step` event: a frame without an id.
func stepFrame(runId: String, tool: String, detail: String) -> Data {
    let event: [String: Any] = [
        "at": "2026-10-25T08:31:02.000Z",
        "type": "run.step",
        "data": ["runId": runId, "step": ["at": "2026-10-25T08:31:02.000Z", "tool": tool, "detail": detail]],
    ]
    return frame(id: nil, event: event)
}

/// One live `message.delta` event: a frame without an id.
func deltaFrame(runId: String, streamId: String, text: String) -> Data {
    let event: [String: Any] = [
        "at": "2026-10-25T08:32:01.120Z",
        "type": "message.delta",
        "data": ["runId": runId, "streamId": streamId, "text": text],
    ]
    return frame(id: nil, event: event)
}

private func frame(id: Int?, event: [String: Any]) -> Data {
    let json = (try? JSONSerialization.data(withJSONObject: event, options: [.sortedKeys])) ?? Data()
    let idLine = id.map { "id: \($0)\n" } ?? ""
    return Data("\(idLine)data: \(String(decoding: json, as: UTF8.self))\n\n".utf8)
}

/// Polls until `condition` holds, on the main actor, for up to five seconds.
@MainActor
func eventually(
    file: StaticString = #filePath,
    line: UInt = #line,
    _ condition: @MainActor () -> Bool
) async {
    for _ in 0..<1000 {
        if condition() { return }
        try? await Task.sleep(for: .milliseconds(5))
    }
    XCTFail("the condition never held", file: file, line: line)
}
