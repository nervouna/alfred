/// A string the server may extend. A value this client does not know decodes as it is,
/// so a newer Alfred can add one without breaking older clients.
public protocol ExtensibleString: Hashable, Sendable, Codable {
    var rawValue: String { get }
    init(rawValue: String)
}

extension ExtensibleString {
    public init(from decoder: any Decoder) throws {
        self.init(rawValue: try decoder.singleValueContainer().decode(String.self))
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
}

/// Where a message came from: the iOS app, or WeChat.
public struct Channel: ExtensibleString {
    public let rawValue: String

    public init(rawValue: String) {
        self.rawValue = rawValue
    }

    public static let app = Channel(rawValue: "app")
    public static let wechat = Channel(rawValue: "wechat")
}

/// The kind of an attached file.
public struct FileKind: ExtensibleString {
    public let rawValue: String

    public init(rawValue: String) {
        self.rawValue = rawValue
    }

    public static let image = FileKind(rawValue: "image")
    public static let voice = FileKind(rawValue: "voice")
    public static let video = FileKind(rawValue: "video")
    public static let file = FileKind(rawValue: "file")
}

/// What started a run: a task from the owner, a scheduled scan, a subagent of another run, a revision of a document, or a generation of ideas.
public struct RunKind: ExtensibleString {
    public let rawValue: String

    public init(rawValue: String) {
        self.rawValue = rawValue
    }

    public static let task = RunKind(rawValue: "task")
    public static let scan = RunKind(rawValue: "scan")
    public static let subagent = RunKind(rawValue: "subagent")
    public static let revision = RunKind(rawValue: "revision")
    public static let ideas = RunKind(rawValue: "ideas")
}

/// The APNs environment a device token belongs to. A development-signed build uses the sandbox.
public enum PushEnvironment: String, Hashable, Sendable, Codable {
    case development
    case production
}

/// Where a run stands.
public struct RunStatus: ExtensibleString {
    public let rawValue: String

    public init(rawValue: String) {
        self.rawValue = rawValue
    }

    public static let queued = RunStatus(rawValue: "queued")
    public static let running = RunStatus(rawValue: "running")
    public static let done = RunStatus(rawValue: "done")
    public static let stopped = RunStatus(rawValue: "stopped")
    public static let failed = RunStatus(rawValue: "failed")
    public static let lost = RunStatus(rawValue: "lost")
}

/// Where a task came from: the owner asked for it, in a chat, or Alfred suggested it as an idea.
public struct TaskOrigin: ExtensibleString {
    public let rawValue: String

    public init(rawValue: String) {
        self.rawValue = rawValue
    }

    public static let manual = TaskOrigin(rawValue: "manual")
    public static let chat = TaskOrigin(rawValue: "chat")
    public static let idea = TaskOrigin(rawValue: "idea")
}

/// Where a task stands: active runs on its schedule, paused waits, and done does not run again.
public struct TaskStatus: ExtensibleString {
    public let rawValue: String

    public init(rawValue: String) {
        self.rawValue = rawValue
    }

    public static let active = TaskStatus(rawValue: "active")
    public static let paused = TaskStatus(rawValue: "paused")
    public static let done = TaskStatus(rawValue: "done")
}

/// The model a task's runs use. Alfred's model keys: `sonnet`, `opus` or `haiku`.
public struct TaskModel: ExtensibleString {
    public let rawValue: String

    public init(rawValue: String) {
        self.rawValue = rawValue
    }

    public static let sonnet = TaskModel(rawValue: "sonnet")
    public static let opus = TaskModel(rawValue: "opus")
    public static let haiku = TaskModel(rawValue: "haiku")
}

/// What an idea proposes: a task to run once, or a recurring one.
public struct IdeaKind: ExtensibleString {
    public let rawValue: String

    public init(rawValue: String) {
        self.rawValue = rawValue
    }

    public static let once = IdeaKind(rawValue: "once")
    public static let recurring = IdeaKind(rawValue: "recurring")
}

/// Where an idea stands: open for the owner, accepted as a task, rejected with a reason, or archived unanswered.
public struct IdeaState: ExtensibleString {
    public let rawValue: String

    public init(rawValue: String) {
        self.rawValue = rawValue
    }

    public static let open = IdeaState(rawValue: "open")
    public static let accepted = IdeaState(rawValue: "accepted")
    public static let rejected = IdeaState(rawValue: "rejected")
    public static let archived = IdeaState(rawValue: "archived")
}

/// Why the owner rejected an idea.
public struct RejectionReason: ExtensibleString {
    public let rawValue: String

    public init(rawValue: String) {
        self.rawValue = rawValue
    }

    public static let notInterested = RejectionReason(rawValue: "not-interested")
    public static let alreadyDoing = RejectionReason(rawValue: "already-doing")
    public static let notNow = RejectionReason(rawValue: "not-now")
    public static let tooExpensive = RejectionReason(rawValue: "too-expensive")
    public static let wrongDirection = RejectionReason(rawValue: "wrong-direction")
}

/// What kind of file a document is. Only markdown and text documents take passage annotations.
public struct DocumentKind: ExtensibleString {
    public let rawValue: String

    public init(rawValue: String) {
        self.rawValue = rawValue
    }

    public static let markdown = DocumentKind(rawValue: "markdown")
    public static let text = DocumentKind(rawValue: "text")
    public static let html = DocumentKind(rawValue: "html")
    public static let pdf = DocumentKind(rawValue: "pdf")
    public static let image = DocumentKind(rawValue: "image")
    public static let other = DocumentKind(rawValue: "other")
}

/// Why a document has a version: a delivery, the end of a revision run, an undo, or the end of another run that changed the file.
public struct DocumentVersionReason: ExtensibleString {
    public let rawValue: String

    public init(rawValue: String) {
        self.rawValue = rawValue
    }

    public static let delivered = DocumentVersionReason(rawValue: "delivered")
    public static let revised = DocumentVersionReason(rawValue: "revised")
    public static let undone = DocumentVersionReason(rawValue: "undone")
    public static let changed = DocumentVersionReason(rawValue: "changed")
}

/// Where an annotation stands: submitted and not yet answered, resolved with a reply, or returned to the owner.
public struct AnnotationState: ExtensibleString {
    public let rawValue: String

    public init(rawValue: String) {
        self.rawValue = rawValue
    }

    public static let submitted = AnnotationState(rawValue: "submitted")
    public static let resolved = AnnotationState(rawValue: "resolved")
    public static let returned = AnnotationState(rawValue: "returned")
}

/// Why an annotation went back to the owner: its run ended without answering it, an undo returned it, the run was stopped, or the run failed.
public struct AnnotationReturnReason: ExtensibleString {
    public let rawValue: String

    public init(rawValue: String) {
        self.rawValue = rawValue
    }

    public static let unanswered = AnnotationReturnReason(rawValue: "unanswered")
    public static let undone = AnnotationReturnReason(rawValue: "undone")
    public static let stopped = AnnotationReturnReason(rawValue: "stopped")
    public static let failed = AnnotationReturnReason(rawValue: "failed")
}
