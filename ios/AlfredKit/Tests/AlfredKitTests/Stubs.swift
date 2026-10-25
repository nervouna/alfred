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

/// Answers every request made through `stubbedSession()` with what `handler` returns. XCTest runs the tests of
/// one process serially, so one handler at a time is enough; each test clears it when it finishes.
final class StubURLProtocol: URLProtocol {
    static let handler = Mutex<(@Sendable (URLRequest) -> StubReply)?>(nil)

    override class func canInit(with request: URLRequest) -> Bool {
        true
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    override func startLoading() {
        let answer = StubURLProtocol.handler.withLock { $0 }
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

/// A session whose requests all go to `StubURLProtocol`.
func stubbedSession() -> URLSession {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [StubURLProtocol.self]
    return URLSession(configuration: configuration)
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

/// The credentials of the pairing fixture, which has made-up values.
func pairedCredentials() throws -> Credentials {
    let pairing = try JSONDecoder().decode(Pairing.self, from: fixture("pairing/pairing.json"))
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
