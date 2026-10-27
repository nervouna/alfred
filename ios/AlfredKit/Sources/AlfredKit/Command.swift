/// A command the client sends to Alfred. Alfred validates it; this type only shapes the JSON.
public enum Command: Hashable, Sendable, Codable {
    /// `files` are inbox paths the owner attached. `text` is empty only when `files` is not.
    case messageSend(clientId: String, text: String, files: [FileRef] = [])
    case runStop(runId: String)
    /// Answers an open question. `answers` maps a question's text to its answer: an option's label, the labels of
    /// several joined with `, ` for a multi-select question, or free text of 1 to 2000 characters.
    case questionAnswer(questionId: String, answers: [String: String])
    /// Creates a task. Alfred fills in the model and budget that the draft leaves out.
    case taskCreate(TaskDraft)
    /// Changes a task. Only the fields `changes` sets are sent.
    case taskUpdate(taskId: String, changes: TaskChanges)
    /// Runs a task now. Its next scheduled time stays as it was.
    case taskRun(taskId: String)
    /// Submits a batch of one to fifty annotations on a document's version, which a revision run takes. `version` is the
    /// version the owner annotated.
    case documentRevise(documentId: String, version: String, annotations: [AnnotationDraft])
    /// Undoes a document's latest revision, named by the revision run that made it.
    case documentUndo(documentId: String, runId: String)
    /// Accepts an idea as a task, with the task as the owner confirmed it. A nil `schedule` makes a one-time task that runs at once.
    case ideaAccept(ideaId: String, title: String, brief: String, schedule: Schedule?, model: TaskModel, budgetUsd: Double)
    /// Rejects an idea with a reason, and an optional note of 1 to 500 characters.
    case ideaReject(ideaId: String, reason: RejectionReason, note: String?)
    /// Asks Alfred to generate ideas now.
    case ideaGenerate

    private enum CodingKeys: String, CodingKey {
        case type, clientId, text, runId, files, questionId, answers
        case title, brief, schedule, model, budgetUsd, taskId, status
        case documentId, version, annotations
        case ideaId, reason, note
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = try container.decode(String.self, forKey: .type)
        switch type {
        case "message.send":
            self = .messageSend(
                clientId: try container.decode(String.self, forKey: .clientId),
                text: try container.decode(String.self, forKey: .text),
                files: try container.decodeIfPresent([FileRef].self, forKey: .files) ?? []
            )
        case "run.stop":
            self = .runStop(runId: try container.decode(String.self, forKey: .runId))
        case "question.answer":
            self = .questionAnswer(
                questionId: try container.decode(String.self, forKey: .questionId),
                answers: try container.decode([String: String].self, forKey: .answers)
            )
        case "task.create":
            self = .taskCreate(TaskDraft(
                title: try container.decode(String.self, forKey: .title),
                brief: try container.decode(String.self, forKey: .brief),
                schedule: try container.decode(Schedule.self, forKey: .schedule),
                model: try container.decodeIfPresent(TaskModel.self, forKey: .model),
                budgetUsd: try container.decodeIfPresent(Double.self, forKey: .budgetUsd)
            ))
        case "task.update":
            self = .taskUpdate(
                taskId: try container.decode(String.self, forKey: .taskId),
                changes: TaskChanges(
                    title: try container.decodeIfPresent(String.self, forKey: .title),
                    brief: try container.decodeIfPresent(String.self, forKey: .brief),
                    schedule: try container.decodeIfPresent(Schedule.self, forKey: .schedule),
                    model: try container.decodeIfPresent(TaskModel.self, forKey: .model),
                    budgetUsd: try container.decodeIfPresent(Double.self, forKey: .budgetUsd),
                    status: try container.decodeIfPresent(TaskStatus.self, forKey: .status)
                )
            )
        case "task.run":
            self = .taskRun(taskId: try container.decode(String.self, forKey: .taskId))
        case "document.revise":
            self = .documentRevise(
                documentId: try container.decode(String.self, forKey: .documentId),
                version: try container.decode(String.self, forKey: .version),
                annotations: try container.decode([AnnotationDraft].self, forKey: .annotations)
            )
        case "document.undo":
            self = .documentUndo(
                documentId: try container.decode(String.self, forKey: .documentId),
                runId: try container.decode(String.self, forKey: .runId)
            )
        case "idea.accept":
            self = .ideaAccept(
                ideaId: try container.decode(String.self, forKey: .ideaId),
                title: try container.decode(String.self, forKey: .title),
                brief: try container.decode(String.self, forKey: .brief),
                schedule: try container.decodeIfPresent(Schedule.self, forKey: .schedule),
                model: try container.decode(TaskModel.self, forKey: .model),
                budgetUsd: try container.decode(Double.self, forKey: .budgetUsd)
            )
        case "idea.reject":
            self = .ideaReject(
                ideaId: try container.decode(String.self, forKey: .ideaId),
                reason: try container.decode(RejectionReason.self, forKey: .reason),
                note: try container.decodeIfPresent(String.self, forKey: .note)
            )
        case "idea.generate":
            self = .ideaGenerate
        default:
            throw DecodingError.dataCorruptedError(
                forKey: .type,
                in: container,
                debugDescription: "unknown command \(type)"
            )
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .messageSend(clientId, text, files):
            try container.encode("message.send", forKey: .type)
            try container.encode(clientId, forKey: .clientId)
            try container.encode(text, forKey: .text)
            if !files.isEmpty {
                try container.encode(files, forKey: .files)
            }
        case let .runStop(runId):
            try container.encode("run.stop", forKey: .type)
            try container.encode(runId, forKey: .runId)
        case let .questionAnswer(questionId, answers):
            try container.encode("question.answer", forKey: .type)
            try container.encode(questionId, forKey: .questionId)
            try container.encode(answers, forKey: .answers)
        case let .taskCreate(draft):
            try container.encode("task.create", forKey: .type)
            try container.encode(draft.title, forKey: .title)
            try container.encode(draft.brief, forKey: .brief)
            try container.encode(draft.schedule, forKey: .schedule)
            try container.encodeIfPresent(draft.model, forKey: .model)
            try container.encodeIfPresent(draft.budgetUsd, forKey: .budgetUsd)
        case let .taskUpdate(taskId, changes):
            try container.encode("task.update", forKey: .type)
            try container.encode(taskId, forKey: .taskId)
            try container.encodeIfPresent(changes.title, forKey: .title)
            try container.encodeIfPresent(changes.brief, forKey: .brief)
            try container.encodeIfPresent(changes.schedule, forKey: .schedule)
            try container.encodeIfPresent(changes.model, forKey: .model)
            try container.encodeIfPresent(changes.budgetUsd, forKey: .budgetUsd)
            try container.encodeIfPresent(changes.status, forKey: .status)
        case let .taskRun(taskId):
            try container.encode("task.run", forKey: .type)
            try container.encode(taskId, forKey: .taskId)
        case let .documentRevise(documentId, version, annotations):
            try container.encode("document.revise", forKey: .type)
            try container.encode(documentId, forKey: .documentId)
            try container.encode(version, forKey: .version)
            try container.encode(annotations, forKey: .annotations)
        case let .documentUndo(documentId, runId):
            try container.encode("document.undo", forKey: .type)
            try container.encode(documentId, forKey: .documentId)
            try container.encode(runId, forKey: .runId)
        case let .ideaAccept(ideaId, title, brief, schedule, model, budgetUsd):
            try container.encode("idea.accept", forKey: .type)
            try container.encode(ideaId, forKey: .ideaId)
            try container.encode(title, forKey: .title)
            try container.encode(brief, forKey: .brief)
            try container.encodeIfPresent(schedule, forKey: .schedule)
            try container.encode(model, forKey: .model)
            try container.encode(budgetUsd, forKey: .budgetUsd)
        case let .ideaReject(ideaId, reason, note):
            try container.encode("idea.reject", forKey: .type)
            try container.encode(ideaId, forKey: .ideaId)
            try container.encode(reason, forKey: .reason)
            try container.encodeIfPresent(note, forKey: .note)
        case .ideaGenerate:
            try container.encode("idea.generate", forKey: .type)
        }
    }
}
