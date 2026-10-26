import AlfredKit
import Foundation

/// Annotations, revision runs and what the server answers a revision with, decoded from the JSON the server sends.
extension TestData {
    /// The JSON of a passage target.
    static func passageTarget(_ quote: String, prefix: String = "", suffix: String = "") -> [String: Any] {
        ["kind": "passage", "quote": quote, "prefix": prefix, "suffix": suffix]
    }

    /// An annotation as the server sends it.
    static func annotationJSON(
        _ id: String,
        documentId: String = "aaaaaa",
        version: String = TestData.commit(1),
        target: [String: Any] = ["kind": "document"],
        comment: String = "请核对数字",
        state: String = "submitted",
        runId: String = "s2d8kp",
        reply: String? = nil,
        returnReason: String? = nil,
        createdAt: String = "2026-10-27T01:00:00.000Z",
        updatedAt: String? = nil
    ) -> [String: Any] {
        var object: [String: Any] = [
            "id": id, "documentId": documentId, "version": version, "target": target, "comment": comment, "state": state,
            "runId": runId, "createdAt": createdAt, "updatedAt": updatedAt ?? createdAt,
        ]
        object["reply"] = reply
        object["returnReason"] = returnReason
        return object
    }

    static func annotation(
        _ id: String,
        documentId: String = "aaaaaa",
        version: String = TestData.commit(1),
        target: [String: Any] = ["kind": "document"],
        comment: String = "请核对数字",
        state: String = "submitted",
        reply: String? = nil,
        returnReason: String? = nil,
        createdAt: String = "2026-10-27T01:00:00.000Z",
        updatedAt: String? = nil
    ) throws -> Annotation {
        let object = annotationJSON(
            id, documentId: documentId, version: version, target: target, comment: comment, state: state, reply: reply,
            returnReason: returnReason, createdAt: createdAt, updatedAt: updatedAt
        )
        return try JSONDecoder().decode(Annotation.self, from: JSONSerialization.data(withJSONObject: object))
    }

    /// A revision run of a document, as the server sends it.
    static func revisionRunObject(
        _ id: String,
        documentId: String = "aaaaaa",
        status: String = "running",
        startedAt: String = "2026-10-27T01:00:05.000Z"
    ) -> [String: Any] {
        ["id": id, "kind": "revision", "documentId": documentId, "title": "修订", "status": status, "startedAt": startedAt, "costUsd": 0, "files": [Any]()]
    }

    static func revisionRun(
        _ id: String,
        documentId: String = "aaaaaa",
        status: String = "running",
        startedAt: String = "2026-10-27T01:00:05.000Z"
    ) throws -> Run {
        let object = revisionRunObject(id, documentId: documentId, status: status, startedAt: startedAt)
        return try JSONDecoder().decode(Run.self, from: JSONSerialization.data(withJSONObject: object))
    }

    /// The body of a 202 for `document.revise`.
    static func revisionAccepted(runId: String = "s2d8kp", annotations: [[String: Any]]) throws -> Data {
        try JSONSerialization.data(withJSONObject: ["runId": runId, "annotations": annotations])
    }

    /// The body of `GET /api/documents/<id>`.
    static func detailJSON(document: [String: Any], versions: [[String: Any]], annotations: [[String: Any]] = [], runs: [[String: Any]] = []) throws -> Data {
        try JSONSerialization.data(withJSONObject: ["document": document, "versions": versions, "annotations": annotations, "runs": runs])
    }

    /// The body of a 200 for `document.undo`.
    static func undone(document: [String: Any]) throws -> Data {
        try JSONSerialization.data(withJSONObject: ["document": document])
    }

    /// A stored `run.updated` event for a revision run.
    static func revisionRunEvent(_ eventId: Int, run: [String: Any]) -> [String: Any] {
        runEvent(eventId, run: run, at: "2026-10-27T01:00:05.000Z")
    }
}
