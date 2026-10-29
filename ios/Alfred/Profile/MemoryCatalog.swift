import AlfredKit
import Foundation

/// A kind of memory, which is a section of the list. Any kind but the four Alfred writes is `other`: a file from before
/// the kinds were fixed may hold another, or none.
enum MemoryKind: CaseIterable, Hashable {
    case user
    case preference
    case project
    case correction
    case other

    init(_ raw: String) {
        switch raw {
        case "user": self = .user
        case "preference": self = .preference
        case "project": self = .project
        case "correction": self = .correction
        default: self = .other
        }
    }

    /// The section's header, and the name of the kind in the detail and the form.
    var title: String {
        switch self {
        case .user: "关于你"
        case .preference: "偏好"
        case .project: "项目"
        case .correction: "纠正"
        case .other: "其他"
        }
    }

    var symbol: String {
        switch self {
        case .user: "person"
        case .preference: "slider.horizontal.3"
        case .project: "folder"
        case .correction: "exclamationmark.bubble"
        case .other: "ellipsis.circle"
        }
    }

    /// The word of the contract the section's memories carry; `other` has none of its own.
    var identifier: String {
        switch self {
        case .user: "user"
        case .preference: "preference"
        case .project: "project"
        case .correction: "correction"
        case .other: "other"
        }
    }
}

/// The memories of one kind, in the order the server listed them.
struct MemorySection: Identifiable, Hashable {
    let kind: MemoryKind
    let memories: [Memory]

    var id: MemoryKind { kind }
}

/// Alfred's long-term memories as the app knows them: the list `GET /api/memories` returned, with the owner's own changes
/// applied to it as they are made. There are no memory events, so a read is the only way another party's change (the
/// agent's, a scan's) arrives.
///
/// The server's order is kept: most recently updated first, which is the order of the index in Alfred's system prompt.
/// The first `promptCount` of the list are in that prompt. A read starts at a `revision` (how many changes have been
/// applied) and replaces the list only if none came meanwhile, since the list is then out of date.
struct MemoryCatalog: Hashable {
    /// Whether a list has been read.
    private(set) var hasLoaded = false
    private(set) var memories: [Memory] = []
    /// How many of the first `memories` are in Alfred's system prompt.
    private(set) var promptCount = 0
    /// How many changes of the owner's have been applied.
    private(set) var revision = 0

    /// Takes a list the server returned. `revision` is the catalog's when the read began: if a change has been applied
    /// since, the list is older than it, and a later read will say what is true.
    mutating func load(_ list: MemoryList, requestedAt revision: Int? = nil) {
        guard revision == nil || revision == self.revision else { return }
        hasLoaded = true
        memories = list.memories
        promptCount = list.promptCount
    }

    /// Takes a memory the server answered a create or an update with. Saving dates a memory today, which makes it the
    /// newest, so it goes first. A new memory joins the prompt when everything was in it; when the index was full, it
    /// pushes the last one out and the count stays.
    mutating func apply(_ memory: Memory) {
        if let index = memories.firstIndex(where: { $0.file == memory.file }) {
            memories.remove(at: index)
        } else if promptCount >= memories.count {
            promptCount += 1
        }
        memories.insert(memory, at: 0)
        revision += 1
    }

    /// Drops a memory the owner deleted, or one the server no longer has.
    mutating func remove(file: String) {
        guard let index = memories.firstIndex(where: { $0.file == file }) else { return }
        if index < promptCount {
            promptCount -= 1
        }
        memories.remove(at: index)
        revision += 1
    }

    func memory(file: String) -> Memory? {
        memories.first { $0.file == file }
    }

    /// Whether the memory is among the first `promptCount`, which Alfred reads in every run.
    func isInPrompt(_ memory: Memory) -> Bool {
        memories.firstIndex { $0.file == memory.file }.map { $0 < promptCount } ?? false
    }

    /// The memories that match `query` in their name, description or body, grouped by kind in the order of the kinds;
    /// a kind with none has no section. Inside a section the order is the server's. A query of spaces matches everything.
    func sections(matching query: String) -> [MemorySection] {
        let query = query.trimmingCharacters(in: .whitespacesAndNewlines)
        let matching = query.isEmpty ? memories : memories.filter { memory in
            memory.name.localizedStandardContains(query)
                || memory.description.localizedStandardContains(query)
                || memory.body.localizedStandardContains(query)
        }
        return MemoryKind.allCases.compactMap { kind in
            let ofKind = matching.filter { MemoryKind($0.kind) == kind }
            return ofKind.isEmpty ? nil : MemorySection(kind: kind, memories: ofKind)
        }
    }
}
