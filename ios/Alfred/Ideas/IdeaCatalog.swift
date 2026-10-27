import AlfredKit
import Foundation

/// Alfred's ideas as the app knows them: the list `GET /api/ideas` returned, and every `idea.updated` event since. Each
/// idea takes its latest version by `updatedAt`, so a list that was read before a change cannot undo it, and a replayed
/// event cannot either. Like the tasks, ideas are only ever merged in; the app starts again from the list.
///
/// The catalog also knows whether a generation is under way. The list says so with `generatingRunId`; after that the
/// `run.updated` events of runs of kind `ideas` do: queued or running is under way, anything else is not. A run the
/// events saw end stays ended, so a list that was read before the end cannot start it again.
///
/// How the last generation that ended went is in the list (`lastGeneration`), not in the events. When one added no
/// ideas the tab says why (`generationLine`), from the moment no generation is under way until a generation starts. A
/// run the events saw end leaves the line out until a list has been read, which holds the outcome of that run.
struct IdeaCatalog: Hashable {
    /// Whether a list has been read.
    private(set) var hasLoaded = false
    private var byId: [String: AlfredIdea] = [:]
    /// The generation runs that are under way.
    private var generating: Set<String> = []
    /// The generation runs the events saw end.
    private var ended: Set<String> = []
    /// The latest generation that ended, as the lists read tell it.
    private(set) var lastGeneration: IdeaGeneration?
    /// A generation ended in the events and no list has been read since, so `lastGeneration` may be the one before it.
    private var awaitingList = false

    /// Merges a list the server returned. The generation it names is under way, and when it names none, none is. Its
    /// last generation is kept unless the catalog holds a later one: a list read before a generation ended may arrive
    /// after the list that tells how it ended.
    mutating func load(_ list: IdeaList) {
        hasLoaded = true
        for idea in list.ideas {
            apply(idea)
        }
        generating = list.generatingRunId.flatMap { ended.contains($0) ? nil : [$0] } ?? []
        if let incoming = list.lastGeneration, incoming.endedAt >= (lastGeneration?.endedAt ?? .distantPast) {
            lastGeneration = incoming
        }
        awaitingList = false
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
                awaitingList = true
            }
        default:
            break
        }
    }

    /// Whether the event is a generation's run leaving queued and running, whatever it left for: how it ended is in the
    /// list, which the app reads again.
    static func endsGeneration(_ event: StreamEvent) -> Bool {
        guard case let .event(stored) = event, case let .runUpdated(run) = stored.payload else { return false }
        return run.kind == .ideas && run.status != .queued && run.status != .running
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

    /// The line for the top of the list when the last generation added no ideas (see `IdeaPresentation.generationLine`).
    /// None while a generation is under way, or while the list that tells how the last one ended has not been read.
    var generationLine: String? {
        guard !isGenerating, !awaitingList, let lastGeneration else { return nil }
        return IdeaPresentation.generationLine(lastGeneration)
    }
}
