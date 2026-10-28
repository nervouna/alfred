import AlfredKit
import Foundation

/// Memories and memory lists for the memory tests, decoded from the JSON the server sends.
extension TestData {
    /// A memory as the server sends it. `file` and `version` default from `name`, so each memory a test makes is its own.
    static func memoryObject(
        _ name: String,
        file: String? = nil,
        description: String = "",
        kind: String = "user",
        updated: String = "2026-10-28",
        body: String = "",
        version: String? = nil
    ) -> [String: Any] {
        let slug = file ?? name.lowercased().replacingOccurrences(of: " ", with: "-") + ".md"
        return [
            "file": slug, "name": name, "description": description, "kind": kind, "updated": updated, "body": body,
            "version": version ?? "v-" + slug,
        ]
    }

    static func memory(
        _ name: String,
        file: String? = nil,
        description: String = "",
        kind: String = "user",
        updated: String = "2026-10-28",
        body: String = "",
        version: String? = nil
    ) throws -> Memory {
        try JSONDecoder().decode(
            Memory.self,
            from: JSONSerialization.data(withJSONObject: memoryObject(
                name, file: file, description: description, kind: kind, updated: updated, body: body, version: version
            ))
        )
    }

    /// The JSON body of `GET /api/memories`.
    static func memoryListJSON(_ memories: [[String: Any]], promptCount: Int? = nil) throws -> Data {
        try JSONSerialization.data(withJSONObject: ["memories": memories, "promptCount": promptCount ?? memories.count])
    }

    static func memoryList(_ memories: [[String: Any]], promptCount: Int? = nil) throws -> MemoryList {
        try JSONDecoder().decode(MemoryList.self, from: memoryListJSON(memories, promptCount: promptCount))
    }

    /// The JSON body of a successful `memory.create` and `memory.update`.
    static func memoryResultJSON(_ memory: [String: Any]) throws -> Data {
        try JSONSerialization.data(withJSONObject: ["memory": memory])
    }
}
