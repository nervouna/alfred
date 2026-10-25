import Foundation

extension KeyedDecodingContainer {
    /// Decodes an ISO 8601 timestamp, with or without fractional seconds.
    func decodeTimestamp(forKey key: Key) throws -> Date {
        let text = try decode(String.self, forKey: key)
        guard let date = parseTimestamp(text) else {
            throw DecodingError.dataCorruptedError(
                forKey: key,
                in: self,
                debugDescription: "\(text) is not an ISO 8601 timestamp"
            )
        }
        return date
    }

    func decodeTimestampIfPresent(forKey key: Key) throws -> Date? {
        guard contains(key) else { return nil }
        if try decodeNil(forKey: key) { return nil }
        return try decodeTimestamp(forKey: key)
    }
}

private func parseTimestamp(_ text: String) -> Date? {
    if let date = try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(text) {
        return date
    }
    return try? Date.ISO8601FormatStyle().parse(text)
}
