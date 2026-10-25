import Foundation

/// The body of `POST /api/uploads`: the file Alfred saved under `inbox/`.
public struct UploadResult: Decodable, Hashable, Sendable {
    public let file: FileRef
}

/// The body of `GET /api/runs`: runs, newest first.
public struct RunList: Decodable, Hashable, Sendable {
    public let runs: [Run]
}

/// The body of `GET /api/runs/<id>`: a run and its step timeline.
public struct RunDetail: Decodable, Hashable, Sendable {
    public let run: Run
    public let steps: [Step]
}

/// The body of any error response from the app API.
public struct ErrorResponse: Decodable, Hashable, Sendable {
    public let error: String
}
