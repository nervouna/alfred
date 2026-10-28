import AlfredKit
import Foundation

/// Documents, their versions and annotations, events and messages for the documents tests, decoded from the JSON the
/// server sends.
extension TestData {
    /// A version id: a 40-character commit id, numbered for the test.
    static func commit(_ number: Int) -> String {
        String(repeating: "0", count: 40 - String(number, radix: 16).count) + String(number, radix: 16)
    }

    /// A document as the server sends it.
    static func documentObject(
        _ id: String,
        path: String = "reports/weekly.md",
        title: String = "周报",
        kind: String = "markdown",
        taskId: String? = nil,
        version: String = TestData.commit(1),
        createdAt: String = "2026-10-26T08:00:00.000Z",
        updatedAt: String? = nil
    ) -> [String: Any] {
        var object: [String: Any] = [
            "id": id, "path": path, "title": title, "kind": kind, "version": version,
            "createdAt": createdAt, "updatedAt": updatedAt ?? createdAt,
        ]
        object["taskId"] = taskId
        return object
    }

    static func document(
        _ id: String,
        path: String = "reports/weekly.md",
        title: String = "周报",
        kind: String = "markdown",
        taskId: String? = nil,
        version: String = TestData.commit(1),
        createdAt: String = "2026-10-26T08:00:00.000Z",
        updatedAt: String? = nil
    ) throws -> AlfredDocument {
        let object = documentObject(
            id, path: path, title: title, kind: kind, taskId: taskId, version: version, createdAt: createdAt, updatedAt: updatedAt
        )
        return try JSONDecoder().decode(AlfredDocument.self, from: JSONSerialization.data(withJSONObject: object))
    }

    /// A stored `document.updated` event.
    static func documentEvent(_ eventId: Int, document: [String: Any], at: String = "2026-10-26T08:00:00.000Z") -> [String: Any] {
        ["id": eventId, "at": at, "type": "document.updated", "data": document]
    }

    /// A stored `document.removed` event.
    static func documentRemovedEvent(_ eventId: Int, id: String, at: String = "2026-10-26T08:00:00.000Z") -> [String: Any] {
        ["id": eventId, "at": at, "type": "document.removed", "data": ["id": id]]
    }

    /// An annotation as the server sends it: a comment on the whole document.
    static func annotationObject(
        _ id: String,
        documentId: String,
        comment: String = "请核对数字",
        state: String = "submitted",
        createdAt: String = "2026-10-27T01:00:00.000Z",
        updatedAt: String? = nil
    ) -> [String: Any] {
        [
            "id": id, "documentId": documentId, "version": TestData.commit(1), "target": ["kind": "document"], "comment": comment,
            "state": state, "runId": "s2d8kp", "createdAt": createdAt, "updatedAt": updatedAt ?? createdAt,
        ]
    }

    /// A stored `annotation.updated` event.
    static func annotationEvent(_ eventId: Int, annotation: [String: Any], at: String = "2026-10-27T01:00:00.000Z") -> [String: Any] {
        ["id": eventId, "at": at, "type": "annotation.updated", "data": annotation]
    }

    /// The body of `GET /api/documents`.
    static func documentList(_ documents: [[String: Any]]) throws -> Data {
        try JSONSerialization.data(withJSONObject: ["documents": documents])
    }

    /// A version of a document as the server sends it.
    static func versionObject(
        _ version: String,
        reason: String = "delivered",
        at: String = "2026-10-26T08:00:00.000Z",
        runId: String? = "k7m2qa",
        undoes: String? = nil
    ) -> [String: Any] {
        var object: [String: Any] = ["version": version, "at": at, "reason": reason]
        object["runId"] = runId
        object["undoes"] = undoes
        return object
    }

    static func version(
        _ version: String,
        reason: String = "delivered",
        at: String = "2026-10-26T08:00:00.000Z",
        runId: String? = "k7m2qa",
        undoes: String? = nil
    ) throws -> DocumentVersion {
        let object = versionObject(version, reason: reason, at: at, runId: runId, undoes: undoes)
        return try JSONDecoder().decode(DocumentVersion.self, from: JSONSerialization.data(withJSONObject: object))
    }

    /// The versions of a document, newest first: three, delivered, revised and changed. The third is the current one.
    static func threeVersions() throws -> [DocumentVersion] {
        [
            try version(commit(3), reason: "changed", at: "2026-10-26T10:00:00.000Z", runId: "t4w9xr"),
            try version(commit(2), reason: "revised", at: "2026-10-26T09:00:00.000Z", runId: "s2d8kp"),
            try version(commit(1), reason: "delivered", at: "2026-10-26T08:00:00.000Z", runId: "k7m2qa"),
        ]
    }

    /// The body of `GET /api/documents/<id>`, with no annotations and no revision runs.
    static func documentDetail(document: [String: Any], versions: [[String: Any]]) throws -> Data {
        try JSONSerialization.data(withJSONObject: [
            "document": document, "versions": versions, "annotations": [Any](), "runs": [Any](),
        ])
    }

    /// A message from Alfred (or the owner) that carries files, each given as the JSON of a `FileRef`.
    static func messageWithFiles(_ id: String, direction: String = "out", files: [[String: Any]]) throws -> Message {
        let object: [String: Any] = [
            "id": id, "channel": "app", "direction": direction, "text": "报告写好了", "files": files, "at": "2026-10-26T08:00:00.000Z",
        ]
        return try JSONDecoder().decode(Message.self, from: JSONSerialization.data(withJSONObject: object))
    }

    /// The JSON of a `FileRef`: a file with a path, and the document and version a delivery registered when there are some.
    static func fileObject(_ path: String, documentId: String? = nil, version: String? = nil) -> [String: Any] {
        var object: [String: Any] = ["path": path, "kind": "file"]
        object["documentId"] = documentId
        object["version"] = version
        return object
    }
}
