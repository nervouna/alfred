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

/// What started a run: a task from the owner, a scheduled scan, or a subagent of another run.
public struct RunKind: ExtensibleString {
    public let rawValue: String

    public init(rawValue: String) {
        self.rawValue = rawValue
    }

    public static let task = RunKind(rawValue: "task")
    public static let scan = RunKind(rawValue: "scan")
    public static let subagent = RunKind(rawValue: "subagent")
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
