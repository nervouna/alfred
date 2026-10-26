/// A message the owner sent that the server has not acknowledged yet. It shows until the stored message with its
/// `clientId` arrives.
public struct PendingMessage: Hashable, Sendable {
    public let clientId: String
    public let text: String
    public let files: [FileRef]
}

/// The reply a run is writing: the text of its latest stream, shown before the stored message replaces it.
public struct Draft: Hashable, Sendable {
    public let runId: String
    public let streamId: String
    public let text: String
}

/// One row of the conversation: a stored message, or a question where it was asked.
public enum TimelineItem: Hashable, Sendable, Identifiable {
    case message(Message)
    case question(QuestionRecord)

    public var id: String {
        switch self {
        case let .message(message): "m-" + message.id
        case let .question(record): "q-" + record.id
        }
    }
}

/// What the chat view shows, folded in order from the event stream. `apply` takes stored events and live events.
/// A stored event whose id is not past `lastEventId` is a replay, and an event or live event of a type this client
/// does not know, changes nothing at all.
public struct Timeline: Hashable, Sendable {
    private static let endedStatuses: Set<RunStatus> = [.done, .stopped, .failed, .lost]

    /// Stored messages, in event id order.
    public private(set) var messages: [Message] = []
    /// The owner's messages not yet stored, in the order they were sent.
    public private(set) var pending: [PendingMessage] = []
    /// The draft reply of each run, by run id.
    public private(set) var drafts: [String: Draft] = [:]
    /// The latest state of each run, by run id.
    public private(set) var runs: [String: Run] = [:]
    /// The latest step of each run, by run id. A run that ends loses its step.
    public private(set) var latestStep: [String: Step] = [:]
    /// Every question Alfred asked, in event order, with how it stands.
    public private(set) var questions: [QuestionRecord] = []
    /// The id of the last stored event applied: where a stream resumes.
    public private(set) var lastEventId: Int64 = 0

    /// The questions Alfred has asked and nobody has answered, by question id.
    public var openQuestions: [String: QuestionAsked] {
        Dictionary(uniqueKeysWithValues: questions.filter { $0.state == .open }.map { ($0.id, $0.asked) })
    }

    /// The conversation in event order: the stored messages, with each question after the messages that came
    /// before it.
    public var items: [TimelineItem] {
        var result: [TimelineItem] = []
        result.reserveCapacity(messages.count + questions.count)
        var next = 0
        for (index, message) in messages.enumerated() {
            while next < questions.count, questions[next].afterMessages <= index {
                result.append(.question(questions[next]))
                next += 1
            }
            result.append(.message(message))
        }
        result.append(contentsOf: questions[next...].map(TimelineItem.question))
        return result
    }

    public init() {}

    /// Shows the owner's message before the server has it.
    public mutating func addPending(clientId: String, text: String, files: [FileRef] = []) {
        pending.append(PendingMessage(clientId: clientId, text: text, files: files))
    }

    public mutating func apply(_ event: StreamEvent) {
        switch event {
        case let .event(stored):
            guard stored.id > lastEventId else { return }
            // An unknown stored event still moves the resume point, so it is not replayed.
            lastEventId = stored.id
            applyStored(stored.payload)
        case let .live(live):
            applyLive(live.payload)
        }
    }

    private mutating func applyStored(_ payload: Event.Payload) {
        switch payload {
        case let .messageCreated(message):
            if message.direction == .inbound, let clientId = message.clientId {
                pending.removeAll { $0.clientId == clientId }
            }
            if message.direction == .outbound, let runId = message.runId {
                drafts[runId] = nil
            }
            if !messages.contains(where: { $0.id == message.id }) {
                messages.append(message)
            }
        case let .runUpdated(run):
            runs[run.id] = run
            if Self.endedStatuses.contains(run.status) {
                drafts[run.id] = nil
                latestStep[run.id] = nil
                // Nobody can answer a question of a run that is over.
                for index in questions.indices where questions[index].asked.runId == run.id && questions[index].state == .open {
                    questions[index].state = .ended
                }
            }
        case let .questionAsked(asked):
            if !questions.contains(where: { $0.id == asked.id }) {
                questions.append(QuestionRecord(asked: asked, afterMessages: messages.count, state: .open))
            }
        case let .questionAnswered(answered):
            // An answer is a fact even when the run's end came first, so it replaces `ended` too.
            if let index = questions.firstIndex(where: { $0.id == answered.id }) {
                questions[index].state = answered.cancelled ? .cancelled : .answered(answered.answers)
            }
        case .taskUpdated:
            // Tasks are not part of the chat's timeline.
            break
        case .unknown:
            break
        }
    }

    private mutating func applyLive(_ payload: LiveEvent.Payload) {
        switch payload {
        case let .messageDelta(runId, streamId, text):
            if let draft = drafts[runId], draft.streamId == streamId {
                drafts[runId] = Draft(runId: runId, streamId: streamId, text: draft.text + text)
            } else {
                drafts[runId] = Draft(runId: runId, streamId: streamId, text: text)
            }
        case let .runStep(runId, step):
            latestStep[runId] = step
        case .unknown:
            break
        }
    }
}
