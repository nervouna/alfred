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

/// The body of a successful `task.create` or `task.update`: the task as Alfred now holds it.
public struct TaskResult: Decodable, Hashable, Sendable {
    public let task: AlfredTask
}

/// The body of `GET /api/tasks`: the time zone the schedules are computed in, and the tasks, newest created first.
public struct TaskList: Decodable, Hashable, Sendable {
    public let timeZone: String
    public let tasks: [AlfredTask]
}

/// The body of `GET /api/tasks/<id>`: a task and its runs, newest first.
public struct TaskDetail: Decodable, Hashable, Sendable {
    public let task: AlfredTask
    public let runs: [Run]
}

/// The body of any error response from the app API.
public struct ErrorResponse: Decodable, Hashable, Sendable {
    public let error: String
}
