import AlfredKit
import Foundation

/// Ideas, idea events and idea lists for the ideas tests, decoded from the JSON the server sends.
extension TestData {
    /// An idea as the server sends it. A recurring idea names its `schedule`; a rejected one its `rejection`; an
    /// accepted one its `taskId`.
    static func ideaObject(
        _ id: String,
        title: String = "盯住供应商状态页",
        why: String = "你之前因此漏掉过一次变化。",
        brief: String = "打开三家供应商的状态页，只报告新出现的故障。",
        kind: String = "once",
        schedule: [String: Any]? = nil,
        model: String = "sonnet",
        estimateUsd: Double = 0.35,
        state: String = "open",
        taskId: String? = nil,
        rejection: [String: Any]? = nil,
        createdAt: String = "2026-10-27T01:00:00.000Z",
        updatedAt: String? = nil
    ) -> [String: Any] {
        var object: [String: Any] = [
            "id": id, "title": title, "why": why, "brief": brief, "kind": kind, "model": model, "estimateUsd": estimateUsd,
            "state": state, "runId": "v7c2mb", "createdAt": createdAt, "updatedAt": updatedAt ?? createdAt,
        ]
        object["schedule"] = schedule
        object["taskId"] = taskId
        object["rejection"] = rejection
        return object
    }

    static func idea(
        _ id: String,
        title: String = "盯住供应商状态页",
        why: String = "你之前因此漏掉过一次变化。",
        brief: String = "打开三家供应商的状态页，只报告新出现的故障。",
        kind: String = "once",
        schedule: [String: Any]? = nil,
        model: String = "sonnet",
        estimateUsd: Double = 0.35,
        state: String = "open",
        taskId: String? = nil,
        rejection: [String: Any]? = nil,
        createdAt: String = "2026-10-27T01:00:00.000Z",
        updatedAt: String? = nil
    ) throws -> AlfredIdea {
        let object = ideaObject(
            id, title: title, why: why, brief: brief, kind: kind, schedule: schedule, model: model, estimateUsd: estimateUsd,
            state: state, taskId: taskId, rejection: rejection, createdAt: createdAt, updatedAt: updatedAt
        )
        return try JSONDecoder().decode(AlfredIdea.self, from: JSONSerialization.data(withJSONObject: object))
    }

    /// A stored `idea.updated` event.
    static func ideaEvent(_ eventId: Int, idea: [String: Any], at: String = "2026-10-27T01:00:00.000Z") -> [String: Any] {
        ["id": eventId, "at": at, "type": "idea.updated", "data": idea]
    }

    /// The body of `GET /api/ideas`.
    static func ideaList(_ ideas: [[String: Any]], generatingRunId: String? = nil) throws -> Data {
        var object: [String: Any] = ["ideas": ideas]
        object["generatingRunId"] = generatingRunId
        return try JSONSerialization.data(withJSONObject: object)
    }

    static func decodedIdeaList(_ ideas: [[String: Any]], generatingRunId: String? = nil) throws -> IdeaList {
        try JSONDecoder().decode(IdeaList.self, from: ideaList(ideas, generatingRunId: generatingRunId))
    }

    /// A stored `run.updated` event for a run of kind `ideas`, a generation.
    static func generationEvent(_ eventId: Int, run runId: String, status: String, at: String = "2026-10-27T01:00:00.000Z") throws -> StreamEvent {
        let run: [String: Any] = [
            "id": runId, "kind": "ideas", "title": "生成想法", "status": status, "startedAt": at, "costUsd": 0, "files": [Any](),
        ]
        return try streamEvent(runEvent(eventId, run: run, at: at))
    }
}
