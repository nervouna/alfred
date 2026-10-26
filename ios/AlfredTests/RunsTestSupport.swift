import AlfredKit
import Foundation

/// Runs, messages and timelines for the runs and documents tests, decoded from the JSON the server sends.
enum TestData {
    static func run(
        _ id: String,
        kind: String = "task",
        status: String = "done",
        title: String = "调研",
        parent: String? = nil,
        model: String? = "claude-haiku-5-5",
        startedAt: String = "2026-10-26T08:00:00.000Z",
        endedAt: String? = nil,
        cost: Double = 0.0123,
        files: [String] = [],
        error: String? = nil
    ) throws -> Run {
        var object: [String: Any] = [
            "id": id, "kind": kind, "title": title, "status": status, "startedAt": startedAt, "costUsd": cost,
            "files": files.map { ["path": $0, "tool": "Write"] },
        ]
        object["parentRunId"] = parent
        object["model"] = model
        object["endedAt"] = endedAt
        object["error"] = error
        return try JSONDecoder().decode(Run.self, from: JSONSerialization.data(withJSONObject: object))
    }

    /// A stored `message.created` event.
    static func messageEvent(
        _ eventId: Int,
        id: String,
        direction: String,
        text: String = "",
        files: [String] = [],
        at: String
    ) -> [String: Any] {
        let message: [String: Any] = [
            "id": id, "channel": "app", "direction": direction, "text": text, "at": at,
            "files": files.map { ["path": $0, "kind": "file"] },
        ]
        return ["id": eventId, "at": at, "type": "message.created", "data": message]
    }

    /// A stored `run.updated` event for a run.
    static func runEvent(_ eventId: Int, run: [String: Any], at: String) -> [String: Any] {
        ["id": eventId, "at": at, "type": "run.updated", "data": run]
    }

    /// The `run.updated` payload of a run, as the server sends it.
    static func runObject(
        _ id: String,
        status: String = "done",
        startedAt: String = "2026-10-26T08:00:00.000Z",
        endedAt: String? = nil,
        files: [String] = []
    ) -> [String: Any] {
        var object: [String: Any] = [
            "id": id, "kind": "task", "title": "调研", "status": status, "startedAt": startedAt, "costUsd": 0,
            "files": files.map { ["path": $0, "tool": "Write"] },
        ]
        object["endedAt"] = endedAt
        return object
    }

    /// A timeline built by applying `events` in order.
    static func timeline(_ events: [[String: Any]]) throws -> Timeline {
        var timeline = Timeline()
        for event in events {
            let data = try JSONSerialization.data(withJSONObject: event)
            timeline.apply(try JSONDecoder().decode(StreamEvent.self, from: data))
        }
        return timeline
    }
}
