import Foundation

/// The app API client: commands, uploads, runs, files and push registration, under the paired credentials.
/// Every request carries the Access service token and the device token. The client does not read or write
/// the keychain; it is given its credentials.
public struct AlfredClient: Sendable {
    private let credentials: Credentials
    private let session: URLSession

    public init(credentials: Credentials, session: URLSession = .shared) {
        self.credentials = credentials
        self.session = session
    }

    /// GET /api/ping. Alfred answers 204 when the credentials are accepted.
    public func ping() async throws {
        let request = authorized("GET", try endpoint("/api/ping"))
        _ = try await fetch(request) { $0 == 204 }
    }

    /// POST /api/commands. Any 2xx is success: Alfred answers 202 when it accepts a command and 200 for a duplicate.
    public func send(_ command: Command) async throws {
        var request = authorized("POST", try endpoint("/api/commands"))
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(command)
        _ = try await fetch(request, success: Self.isSuccess)
    }

    /// POST /api/uploads?name=…, streamed from the file on disk. Alfred saves it under `inbox/`.
    /// `progress` is called with the fraction of the body sent, from 0 to 1, as it goes out.
    public func upload(
        fileAt fileURL: URL,
        name: String,
        contentType: String,
        progress: (@Sendable (Double) -> Void)? = nil
    ) async throws -> FileRef {
        var request = authorized("POST", try endpoint("/api/uploads", query: "name=" + Self.encode(name)))
        request.setValue(contentType, forHTTPHeaderField: "Content-Type")
        let (data, response) = try await session.upload(
            for: request,
            fromFile: fileURL,
            delegate: progress.map(UploadProgress.init)
        )
        let result = try JSONDecoder().decode(UploadResult.self, from: Self.check(data, response, success: Self.isSuccess))
        return result.file
    }

    /// GET /api/runs: the runs, newest first.
    public func runs() async throws -> [Run] {
        try await get(RunList.self, "/api/runs").runs
    }

    /// GET /api/runs/<id>: a run and its steps.
    public func run(id: String) async throws -> RunDetail {
        try await get(RunDetail.self, "/api/runs/" + Self.encode(id))
    }

    /// GET /api/files/<path>, downloaded to a temporary file. The file keeps its name; each path segment is encoded.
    public func file(path: String) async throws -> URL {
        let segments = path.components(separatedBy: "/").map(Self.encode).joined(separator: "/")
        let request = authorized("GET", try endpoint("/api/files/" + segments))
        let (downloaded, response) = try await session.download(for: request)
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        guard http.statusCode == 200 else {
            throw Self.failure(status: http.statusCode, body: (try? Data(contentsOf: downloaded)) ?? Data())
        }
        let folder = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString, directoryHint: .isDirectory)
        let name = path.components(separatedBy: "/").last.flatMap { $0.isEmpty ? nil : $0 } ?? "file"
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let destination = folder.appending(path: name)
        try FileManager.default.moveItem(at: downloaded, to: destination)
        return destination
    }

    /// POST /api/push. Alfred answers 204.
    public func registerPush(_ registration: PushRegistration) async throws {
        var request = authorized("POST", try endpoint("/api/push"))
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(registration)
        _ = try await fetch(request) { $0 == 204 }
    }

    /// GET /api/events from an event id, as the body's bytes. Only a 200 gets a stream; any other status throws
    /// before a byte is read.
    func events(after id: Int64) async throws -> URLSession.AsyncBytes {
        var request = authorized("GET", try endpoint("/api/events"))
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        request.setValue(String(id), forHTTPHeaderField: "Last-Event-ID")
        let (bytes, response) = try await session.bytes(for: request)
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        guard http.statusCode == 200 else { throw Self.failure(status: http.statusCode, body: Data()) }
        return bytes
    }

    private func get<T: Decodable>(_ type: T.Type, _ path: String) async throws -> T {
        let request = authorized("GET", try endpoint(path))
        return try JSONDecoder().decode(T.self, from: await fetch(request, success: Self.isSuccess))
    }

    private func fetch(_ request: URLRequest, success: (Int) -> Bool) async throws -> Data {
        let (data, response) = try await session.data(for: request)
        return try Self.check(data, response, success: success)
    }

    private func authorized(_ method: String, _ url: URL) -> URLRequest {
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue(credentials.accessClientId, forHTTPHeaderField: "CF-Access-Client-Id")
        request.setValue(credentials.accessClientSecret, forHTTPHeaderField: "CF-Access-Client-Secret")
        request.setValue("Bearer \(credentials.deviceToken)", forHTTPHeaderField: "Authorization")
        return request
    }

    /// The server's URL with `path` (already percent-encoded) and an optional encoded query.
    private func endpoint(_ path: String, query: String? = nil) throws -> URL {
        var components = URLComponents(url: credentials.server, resolvingAgainstBaseURL: false)
        components?.percentEncodedPath += path
        components?.percentEncodedQuery = query
        guard let url = components?.url else { throw URLError(.badURL) }
        return url
    }

    private static func check(_ data: Data, _ response: URLResponse, success: (Int) -> Bool) throws -> Data {
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        guard success(http.statusCode) else { throw failure(status: http.statusCode, body: data) }
        return data
    }

    /// The error for a response a call does not expect. 401 and 403 are always the access errors.
    private static func failure(status: Int, body: Data) -> AlfredError {
        switch status {
        case 401:
            return .unauthorized
        case 403:
            return .forbidden
        default:
            let message = try? JSONDecoder().decode(ErrorResponse.self, from: body).error
            return .http(status: status, message: message)
        }
    }

    private static func isSuccess(_ status: Int) -> Bool {
        (200..<300).contains(status)
    }

    private static let unreserved = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")

    /// Percent-encodes everything but the RFC 3986 unreserved characters, so one path segment or query value
    /// cannot change the URL's structure. ASCII only: letters from other scripts are encoded too.
    private static func encode(_ text: String) -> String {
        text.addingPercentEncoding(withAllowedCharacters: unreserved) ?? text
    }
}

/// Reports how much of an upload's body has gone out.
private final class UploadProgress: NSObject, URLSessionTaskDelegate {
    private let report: @Sendable (Double) -> Void

    init(report: @escaping @Sendable (Double) -> Void) {
        self.report = report
    }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        didSendBodyData bytesSent: Int64,
        totalBytesSent: Int64,
        totalBytesExpectedToSend: Int64
    ) {
        guard totalBytesExpectedToSend > 0 else { return }
        report(min(1, Double(totalBytesSent) / Double(totalBytesExpectedToSend)))
    }
}
