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

/// The body of a successful `document.undo`: the document as Alfred now holds it.
public struct DocumentResult: Decodable, Hashable, Sendable {
    public let document: AlfredDocument
}

/// The body of `GET /api/documents`: the documents, newest updated first.
public struct DocumentList: Decodable, Hashable, Sendable {
    public let documents: [AlfredDocument]
}

/// The body of `GET /api/documents/<id>`: a document, its versions (newest first, the first being the current one), its
/// annotations and its revision runs (newest first).
public struct DocumentDetail: Decodable, Hashable, Sendable {
    public let document: AlfredDocument
    public let versions: [DocumentVersion]
    public let annotations: [Annotation]
    public let runs: [Run]
}

/// The body of a successful `document.revise`: the revision run and the batch as Alfred recorded it, each annotation
/// submitted to that run.
public struct RevisionAccepted: Decodable, Hashable, Sendable {
    public let runId: String
    public let annotations: [Annotation]
}

/// The body of a successful `idea.reject`: the idea as Alfred now holds it.
public struct IdeaResult: Decodable, Hashable, Sendable {
    public let idea: AlfredIdea
}

/// The body of a successful `idea.accept`: the idea, now accepted, and the task it made.
public struct IdeaAccepted: Decodable, Hashable, Sendable {
    public let idea: AlfredIdea
    public let task: AlfredTask
}

/// The body of a successful `idea.generate`: the generation run, queued or running.
public struct IdeaGenerationAccepted: Decodable, Hashable, Sendable {
    public let runId: String
}

/// The body of `GET /api/ideas`: every idea Alfred keeps, newest created first, the generation run while one is queued
/// or running, and the latest generation that ended.
public struct IdeaList: Decodable, Hashable, Sendable {
    public let ideas: [AlfredIdea]
    public let generatingRunId: String?
    public let lastGeneration: IdeaGeneration?
}

/// The body of any error response from the app API.
public struct ErrorResponse: Decodable, Hashable, Sendable {
    public let error: String
}
