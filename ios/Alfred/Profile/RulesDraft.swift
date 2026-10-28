import AlfredKit
import Foundation

/// The owner's edit of the root ALFRED.md: the text being typed, and the rules it was made from. A save names `version`,
/// which is why a draft keeps the one it started from and not whatever the app has read since. It lives only while the
/// editor is open.
struct RulesDraft: Equatable {
    /// The text the draft started from.
    private(set) var original: String
    /// The version of the file the draft started from, which a save is made against.
    private(set) var version: String
    /// The most the text may hold, in UTF-8 bytes (the server's).
    private(set) var maxBytes: Int
    /// What the owner has typed.
    var text: String
    /// A save was refused because the file is not at `version` any more, and the owner has not yet chosen what to do.
    private(set) var hasConflict = false

    init(_ rules: Rules) {
        original = rules.text
        version = rules.version
        maxBytes = rules.maxBytes
        text = rules.text
    }

    var isChanged: Bool {
        text != original
    }

    var byteCount: Int {
        text.utf8.count
    }

    var isOverLimit: Bool {
        byteCount > maxBytes
    }

    /// The count the editor's bottom bar shows.
    var countText: String {
        "\(byteCount) / \(maxBytes)"
    }

    /// Whether 保存 is on: the text differs from the original, fits, and no save is out.
    func canSave(isSaving: Bool) -> Bool {
        isChanged && !isOverLimit && !isSaving
    }

    /// The server refused a save as a conflict. The text stays.
    mutating func noteConflict() {
        hasConflict = true
    }

    /// The owner stays in the editor with what was typed. The draft is still against its old version, so a save made from
    /// it conflicts again until it is reloaded.
    mutating func keepDraft() {
        hasConflict = false
    }

    /// The owner chose 载入新内容: the draft is what the server holds now, and what was typed is gone.
    mutating func reload(_ rules: Rules) {
        self = RulesDraft(rules)
    }
}

/// What came of saving the owner's edit of ALFRED.md.
enum RulesSaving: Equatable {
    /// 200: the rules as the file now holds them.
    case saved(Rules)
    /// 409: the file is no longer at the version the edit was made against.
    case conflict
    /// Any other refusal, or no answer. The alert has been raised, and the draft stays.
    case failed
}
