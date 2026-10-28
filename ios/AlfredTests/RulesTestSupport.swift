import AlfredKit
import Foundation

/// Rules as the server sends them, for the rules tests.
extension TestData {
    /// The JSON body of `GET /api/rules` and of a successful `rules.save`.
    static func rulesJSON(text: String, version: String = String(repeating: "a", count: 64), maxBytes: Int = 8192) throws -> Data {
        try JSONSerialization.data(withJSONObject: ["text": text, "version": version, "maxBytes": maxBytes])
    }

    static func rules(text: String, version: String = String(repeating: "a", count: 64), maxBytes: Int = 8192) throws -> Rules {
        try JSONDecoder().decode(Rules.self, from: rulesJSON(text: text, version: version, maxBytes: maxBytes))
    }
}
