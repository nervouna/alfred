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
/// handler under a host of its own (see `stubbedClient`) and only its own client sends there, so a request left
/// over from an earlier test, such as the reconnect of a stream that was cancelled, finds no handler of the
/// running test and cannot take a reply meant for it. A host without a handler gets a 599.
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

extension XCTestCase {
    /// A client whose every request is answered by `handler`. The handler is registered under a host that only
    /// this client uses, and removed when the test ends. The session is not invalidated then: a stream that was
    /// cancelled may still be winding down, and creating a task on an invalidated session raises an exception.
    func stubbedClient(_ handler: @escaping StubURLProtocol.Handler) throws -> AlfredClient {
        let host = UUID().uuidString.lowercased() + ".stub.test"
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubURLProtocol.self]
        let session = URLSession(configuration: configuration)
        StubURLProtocol.register(handler, forHost: host)
        addTeardownBlock { StubURLProtocol.unregister(host: host) }
        return AlfredClient(credentials: try pairedCredentials(server: "https://" + host), session: session)
    }
}

/// The requests a stub saw, with their bodies, in arrival order.
final class RequestLog: Sendable {
    struct Entry: Sendable {
        let request: URLRequest
        let body: Data
    }

    private let items = Mutex<[Entry]>([])

    func record(_ request: URLRequest) {
        let entry = Entry(request: request, body: bodyData(of: request))
        items.withLock { $0.append(entry) }
    }

    var entries: [Entry] {
        items.withLock { $0 }
    }
}

/// The body of a request, whether it was sent from memory or streamed from a file.
func bodyData(of request: URLRequest) -> Data {
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

/// A shared fixture file's bytes.
func fixture(_ path: String) throws -> Data {
    try Data(contentsOf: Fixtures.directory.appending(path: path))
}

/// The credentials of the pairing fixture, which has made-up values, for `server` instead of the fixture's own if given.
func pairedCredentials(server: String? = nil) throws -> Credentials {
    var object = try XCTUnwrap(JSONSerialization.jsonObject(with: fixture("pairing/pairing.json")) as? [String: Any])
    if let server { object["server"] = server }
    let pairing = try JSONDecoder().decode(Pairing.self, from: JSONSerialization.data(withJSONObject: object))
    return Credentials(pairing: pairing)
}

/// The percent-encoded path of a request's URL, so encoding can be checked.
func encodedPath(_ request: URLRequest, file: StaticString = #filePath, line: UInt = #line) throws -> String {
    let url = try XCTUnwrap(request.url, file: file, line: line)
    return try XCTUnwrap(URLComponents(url: url, resolvingAgainstBaseURL: false)?.percentEncodedPath, file: file, line: line)
}

/// The percent-encoded query of a request's URL.
func encodedQuery(_ request: URLRequest, file: StaticString = #filePath, line: UInt = #line) throws -> String? {
    let url = try XCTUnwrap(request.url, file: file, line: line)
    return URLComponents(url: url, resolvingAgainstBaseURL: false)?.percentEncodedQuery
}

/// Every request carries the Access service token and the device token.
func assertCredentials(_ request: URLRequest, file: StaticString = #filePath, line: UInt = #line) {
    XCTAssertEqual(request.value(forHTTPHeaderField: "CF-Access-Client-Id"), "example-service-token.access", file: file, line: line)
    XCTAssertEqual(request.value(forHTTPHeaderField: "CF-Access-Client-Secret"), "example-client-secret-not-real", file: file, line: line)
    XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer EXAMPLE-DEVICE-TOKEN-NOT-REAL-0123456789abc", file: file, line: line)
}

/// Compares two JSON documents as objects, so key order and whitespace do not matter.
func assertSameJSON(_ actual: Data, _ expected: Data, file: StaticString = #filePath, line: UInt = #line) throws {
    let left = try XCTUnwrap(JSONSerialization.jsonObject(with: actual) as? NSDictionary, file: file, line: line)
    let right = try XCTUnwrap(JSONSerialization.jsonObject(with: expected) as? NSDictionary, file: file, line: line)
    XCTAssertTrue(left.isEqual(right), "\(left) is not \(right)", file: file, line: line)
}
