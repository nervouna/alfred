import AlfredKit
import Foundation

/// Alfred's ideas as the app knows them: the list `GET /api/ideas` returned, and every `idea.updated` event since. Each
/// idea takes its latest version by `updatedAt`, so a list that was read before a change cannot undo it, and a replayed
/// event cannot either. Like the tasks, ideas are only ever merged in; the app starts again from the list.
///
/// The catalog also knows whether a generation is under way. The list says so with `generatingRunId`; after that the
/// `run.updated` events of runs of kind `ideas` do: queued or running is under way, anything else is not. A run the
/// events saw end stays ended, so a list that was read before the end cannot start it again.
struct IdeaCatalog: Hashable {
    /// Whether a list has been read.
    private(set) var hasLoaded = false
    private var byId: [String: AlfredIdea] = [:]
    /// The generation runs that are under way.
    private var generating: Set<String> = []
    /// The generation runs the events saw end.
    private var ended: Set<String> = []

    /// Merges a list the server returned. The generation it names is under way, and when it names none, none is.
    mutating func load(_ list: IdeaList) {
        hasLoaded = true
        for idea in list.ideas {
            apply(idea)
        }
        generating = list.generatingRunId.flatMap { ended.contains($0) ? nil : [$0] } ?? []
    }

    /// A stored `idea.updated` event changes its idea, and a `run.updated` event of a generation its state; any other
    /// event changes nothing.
    mutating func apply(_ event: StreamEvent) {
        guard case let .event(stored) = event else { return }
        switch stored.payload {
        case let .ideaUpdated(idea):
            apply(idea)
        case let .runUpdated(run) where run.kind == .ideas:
            if run.status == .queued || run.status == .running {
                noteGeneration(runId: run.id)
            } else {
                generating.remove(run.id)
                ended.insert(run.id)
            }
        default:
            break
        }
    }

    /// Takes an idea unless the catalog already holds a newer version of it.
    mutating func apply(_ idea: AlfredIdea) {
        if let known = byId[idea.id], known.updatedAt > idea.updatedAt { return }
        byId[idea.id] = idea
    }

    /// A generation was accepted (`idea.generate` answered 202): it is under way, unless its end has come already.
    mutating func noteGeneration(runId: String) {
        if !ended.contains(runId) {
            generating.insert(runId)
        }
    }

    func idea(id: String) -> AlfredIdea? {
        byId[id]
    }

    /// The ids of the ideas the catalog holds.
    var ids: Set<String> {
        Set(byId.keys)
    }

    /// The ideas waiting for the owner, newest created first.
    var open: [AlfredIdea] {
        byId.values.filter { $0.state == .open }.sorted { first, second in
            first.createdAt != second.createdAt ? first.createdAt > second.createdAt : first.id < second.id
        }
    }

    /// The ideas that are accepted, rejected or archived (or in a state this app does not know), newest updated first.
    var history: [AlfredIdea] {
        byId.values.filter { $0.state != .open }.sorted { first, second in
            first.updatedAt != second.updatedAt ? first.updatedAt > second.updatedAt : first.id < second.id
        }
    }

    /// Whether Alfred is generating ideas right now.
    var isGenerating: Bool {
        !generating.isEmpty
    }
}
