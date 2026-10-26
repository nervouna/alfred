import AlfredKit
import Foundation

/// Tasks, task events and messages for the tasks tests, decoded from the JSON the server sends.
extension TestData {
    /// A task as the server sends it. `nextRunAt` is set only for an active task, as the contract has it.
    static func taskObject(
        _ id: String,
        title: String = "每日简报",
        brief: String = "写一份简报",
        status: String = "active",
        schedule: [String: Any] = ["kind": "daily", "time": "08:00"],
        model: String = "sonnet",
        budgetUsd: Double = 2,
        origin: String = "manual",
        createdAt: String = "2026-10-26T08:00:00.000Z",
        updatedAt: String? = nil,
        nextRunAt: String? = "2026-10-27T00:00:00.000Z",
        skips: [[String: Any]] = []
    ) -> [String: Any] {
        var object: [String: Any] = [
            "id": id, "title": title, "brief": brief, "origin": origin, "schedule": schedule, "status": status,
            "model": model, "budgetUsd": budgetUsd, "createdAt": createdAt, "updatedAt": updatedAt ?? createdAt,
            "skips": skips,
        ]
        if status == "active" {
            object["nextRunAt"] = nextRunAt
        }
        return object
    }

    static func task(
        _ id: String,
        title: String = "每日简报",
        brief: String = "写一份简报",
        status: String = "active",
        schedule: [String: Any] = ["kind": "daily", "time": "08:00"],
        model: String = "sonnet",
        budgetUsd: Double = 2,
        origin: String = "manual",
        createdAt: String = "2026-10-26T08:00:00.000Z",
        updatedAt: String? = nil,
        nextRunAt: String? = "2026-10-27T00:00:00.000Z",
        skips: [[String: Any]] = []
    ) throws -> AlfredTask {
        let object = taskObject(
            id, title: title, brief: brief, status: status, schedule: schedule, model: model, budgetUsd: budgetUsd,
            origin: origin, createdAt: createdAt, updatedAt: updatedAt, nextRunAt: nextRunAt, skips: skips
        )
        return try JSONDecoder().decode(AlfredTask.self, from: JSONSerialization.data(withJSONObject: object))
    }

    /// A stored `task.updated` event.
    static func taskEvent(_ eventId: Int, task: [String: Any], at: String = "2026-10-26T08:00:00.000Z") -> [String: Any] {
        ["id": eventId, "at": at, "type": "task.updated", "data": task]
    }

    /// An event as the stream delivers it, decoded.
    static func streamEvent(_ event: [String: Any]) throws -> StreamEvent {
        try JSONDecoder().decode(StreamEvent.self, from: JSONSerialization.data(withJSONObject: event))
    }

    /// A message, optionally one a task's run delivered.
    static func message(
        _ id: String,
        direction: String = "out",
        text: String = "报告写好了",
        taskId: String? = nil
    ) throws -> Message {
        var object: [String: Any] = [
            "id": id, "channel": "app", "direction": direction, "text": text, "files": [Any](), "at": "2026-10-26T08:00:00.000Z",
        ]
        object["taskId"] = taskId
        return try JSONDecoder().decode(Message.self, from: JSONSerialization.data(withJSONObject: object))
    }

    /// The body of `GET /api/tasks`.
    static func taskList(zone: String = "Asia/Taipei", _ tasks: [[String: Any]]) throws -> Data {
        try JSONSerialization.data(withJSONObject: ["timeZone": zone, "tasks": tasks])
    }
}
