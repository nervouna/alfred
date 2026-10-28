import AlfredKit
import Foundation

/// The owner's edit of a memory, or a new one: what has been typed, and the memory it was made from. A save names
/// `version`, which is why a draft keeps the one it started from and not whatever the app has read since. It lives only
/// while the form is open.
///
/// The limits are the contract's (`memory.create`): a name of 1 to 80 characters and a description of up to 200, each
/// one trimmed line, and a body of up to 8192 bytes of UTF-8. Characters are counted as the server counts them, in
/// Unicode scalars.
struct MemoryDraft: Equatable {
    /// The kinds the contract takes, in the order of the list's sections.
    static let kinds = ["user", "preference", "project", "correction"]
    static let maxNameCharacters = 80
    static let maxDescriptionCharacters = 200
    static let maxBodyBytes = 8192

    /// Why a draft cannot be saved.
    enum Problem: Equatable {
        case nameEmpty
        case nameTooLong
        case nameNotOneLine
        case descriptionTooLong
        case descriptionNotOneLine
        case bodyTooLong
        case bodyHasNul
        case kindUnknown

        /// What the form says about it under the field. Nothing for an empty name, which 保存 being off already shows, and
        /// nothing for a body over the limit, which the count in red shows.
        var message: String? {
            switch self {
            case .nameEmpty, .bodyTooLong: nil
            case .nameTooLong: "名称最多 \(MemoryDraft.maxNameCharacters) 个字符"
            case .nameNotOneLine: "名称只能写一行"
            case .descriptionTooLong: "描述最多 \(MemoryDraft.maxDescriptionCharacters) 个字符"
            case .descriptionNotOneLine: "描述只能写一行"
            case .bodyHasNul: "正文不能含有空字符"
            case .kindUnknown: "请选择一个类型"
            }
        }
    }

    private struct Fields: Equatable {
        var name = ""
        var description = ""
        var kind = MemoryDraft.kinds[0]
        var body = ""
    }

    /// The memory being edited; `nil` for a new one.
    private(set) var file: String?
    /// The version of the memory the draft started from, which a save is made against; `nil` for a new one.
    private(set) var version: String?
    private var original = Fields()
    var name: String
    var description: String
    var kind: String
    var body: String

    /// A draft for a new memory.
    init() {
        let blank = Fields()
        name = blank.name
        description = blank.description
        kind = blank.kind
        body = blank.body
    }

    /// A draft for changing `memory`.
    init(editing memory: Memory) {
        file = memory.file
        version = memory.version
        original = Fields(name: memory.name, description: memory.description, kind: memory.kind, body: memory.body)
        name = memory.name
        description = memory.description
        kind = memory.kind
        body = memory.body
    }

    var isNew: Bool {
        file == nil
    }

    /// The draft becomes the memory as the server holds it now, and what was typed is gone.
    mutating func reload(_ memory: Memory) {
        self = MemoryDraft(editing: memory)
    }

    // MARK: What is sent

    /// The name as it goes out: the line, trimmed.
    var sentName: String {
        Self.trimmed(name)
    }

    var sentDescription: String {
        Self.trimmed(description)
    }

    private static func trimmed(_ text: String) -> String {
        text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    // MARK: Change

    /// Whether the draft differs from what it started from. A line is compared as it will be sent, so spaces at its ends
    /// are no change.
    var isChanged: Bool {
        sentName != Self.trimmed(original.name)
            || sentDescription != Self.trimmed(original.description)
            || kind != original.kind
            || body != original.body
    }

    // MARK: The kind

    /// The kinds the picker offers. A memory of an older kind (any other string, or none) offers that kind as well, for
    /// as long as the form is open, so it can be seen and left; saving needs one of the four.
    var kindChoices: [String] {
        Self.kinds.contains(original.kind) ? Self.kinds : Self.kinds + [original.kind]
    }

    // MARK: The body's size

    var bodyByteCount: Int {
        body.utf8.count
    }

    var isBodyOverLimit: Bool {
        bodyByteCount > Self.maxBodyBytes
    }

    /// The count the form's body section shows.
    var bodyCountText: String {
        "\(bodyByteCount) / \(Self.maxBodyBytes)"
    }

    // MARK: Validity

    /// What the server would refuse, in the order of the fields.
    var problems: [Problem] {
        var problems: [Problem] = []
        let name = sentName
        if name.isEmpty {
            problems.append(.nameEmpty)
        } else {
            if !Self.isOneLine(name) { problems.append(.nameNotOneLine) }
            if name.unicodeScalars.count > Self.maxNameCharacters { problems.append(.nameTooLong) }
        }
        let description = sentDescription
        if !Self.isOneLine(description) { problems.append(.descriptionNotOneLine) }
        if description.unicodeScalars.count > Self.maxDescriptionCharacters { problems.append(.descriptionTooLong) }
        if isBodyOverLimit { problems.append(.bodyTooLong) }
        if body.unicodeScalars.contains("\0") { problems.append(.bodyHasNul) }
        if !Self.kinds.contains(kind) { problems.append(.kindUnknown) }
        return problems
    }

    var isValid: Bool {
        problems.isEmpty
    }

    /// Whether 保存 is on: the draft is valid, differs from the original, and no save is out.
    func canSave(isSaving: Bool) -> Bool {
        isValid && isChanged && !isSaving
    }

    /// No control character and no line or paragraph separator, which is what the contract means by one line.
    private static func isOneLine(_ text: String) -> Bool {
        !text.unicodeScalars.contains { scalar in
            switch scalar.properties.generalCategory {
            case .control, .lineSeparator, .paragraphSeparator: true
            default: false
            }
        }
    }
}

/// What came of saving a memory, new or changed.
enum MemorySaving: Equatable {
    /// 200 or 201: the memory as its file now holds it.
    case saved(Memory)
    /// 409: the memory is no longer at the version the edit was made against.
    case stale
    /// 404: the memory is gone.
    case gone
    /// Any other refusal, or no answer: the words to show beside the draft, which stays. A 409 that is not a stale version
    /// is one of these, with Alfred's own message (he is tidying memory).
    case refused(String)
}

/// What came of deleting a memory.
enum MemoryDeleting: Equatable {
    /// 200: the memory is gone from the list.
    case deleted
    /// 409: the memory is no longer at the version the owner read; it stays in the list.
    case stale
    /// 404: the memory was already gone, and has left the list.
    case gone
    /// Any other refusal, or no answer, with the words that the usual alert has shown.
    case refused(String)
}

/// The two kinds of 409 a memory command answers with.
enum MemoryConflict {
    /// The server words a stale version `version: not the current version of <file>`, and a busy Alfred, a full
    /// workspace or any other refusal in plain words. A 409 with no message at all is taken for a stale version too, since
    /// that is what the contract says a 409 is.
    static func isStaleVersion(message: String?) -> Bool {
        guard let message else { return true }
        return message.hasPrefix("version:")
    }
}
