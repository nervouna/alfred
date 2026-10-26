import AlfredKit
import Foundation

/// The owner's tasks as the app knows them: the list `GET /api/tasks` returned, and every `task.updated` event since.
/// Each task takes its latest version, so a list that was read before a change cannot undo it, and a replayed event
/// cannot either. A task is never removed: Alfred has no hard delete, and an ended task stays as one that is done.
struct TaskCatalog: Hashable {
    /// The zone the schedules are computed in, once a list has said so.
    private(set) var timeZone: String?
    /// Whether a list has been read.
    private(set) var hasLoaded = false
    private var byId: [String: AlfredTask] = [:]

    /// Merges a list the server returned.
    mutating func load(_ list: TaskList) {
        timeZone = list.timeZone
        hasLoaded = true
        for task in list.tasks {
            apply(task)
        }
    }

    /// A stored `task.updated` event changes its task; any other event changes nothing.
    mutating func apply(_ event: StreamEvent) {
        guard case let .event(stored) = event, case let .taskUpdated(task) = stored.payload else { return }
        apply(task)
    }

    /// Takes a task unless the catalog already holds a newer version of it.
    mutating func apply(_ task: AlfredTask) {
        if let known = byId[task.id], known.updatedAt > task.updatedAt { return }
        byId[task.id] = task
    }

    func task(id: String) -> AlfredTask? {
        byId[id]
    }

    /// The tasks that are active or paused, newest created first.
    var open: [AlfredTask] {
        ordered(byId.values.filter { $0.status != .done })
    }

    /// The tasks that have ended, newest created first.
    var ended: [AlfredTask] {
        ordered(byId.values.filter { $0.status == .done })
    }

    /// The title a message from a task's run carries in the chat: only Alfred's messages have one, and only for a task
    /// the catalog knows.
    func label(for message: Message) -> String? {
        guard message.direction == .outbound, let taskId = message.taskId else { return nil }
        return byId[taskId]?.title
    }

    private func ordered(_ tasks: some Sequence<AlfredTask>) -> [AlfredTask] {
        tasks.sorted { first, second in
            first.createdAt != second.createdAt ? first.createdAt > second.createdAt : first.id < second.id
        }
    }
}
