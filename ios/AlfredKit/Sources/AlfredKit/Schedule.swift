import Foundation

/// A time of day, 24-hour, from 00:00 to 23:59. It codes as `"HH:MM"`, and any other text does not decode.
public struct TimeOfDay: Codable, Hashable, Sendable {
    public let hour: Int
    public let minute: Int

    public init(hour: Int, minute: Int) {
        self.hour = hour
        self.minute = minute
    }

    public init(from decoder: any Decoder) throws {
        let text = try decoder.singleValueContainer().decode(String.self)
        let parts = text.split(separator: ":", omittingEmptySubsequences: false)
        let isTwoDigits = { (part: Substring) in part.count == 2 && part.allSatisfy { ("0"..."9").contains($0) } }
        guard parts.count == 2, parts.allSatisfy(isTwoDigits),
              let hour = Int(parts[0]), let minute = Int(parts[1]),
              (0...23).contains(hour), (0...59).contains(minute)
        else {
            throw DecodingError.dataCorrupted(.init(
                codingPath: decoder.codingPath,
                debugDescription: "\(text) is not a time as HH:MM, from 00:00 to 23:59"
            ))
        }
        self.hour = hour
        self.minute = minute
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(String(format: "%02d:%02d", hour, minute))
    }
}

/// When a task runs. It codes as an object whose `kind` is `once`, `daily`, `weekly` or `interval`. The contract
/// has no fallback for another kind, so one does not decode.
public enum Schedule: Hashable, Sendable, Codable {
    /// Once, at a time. The task is done after it runs.
    case once(at: Date)
    case daily(time: TimeOfDay)
    /// On these ISO weekdays, 1 for Monday to 7 for Sunday, in ascending order.
    case weekly(days: [Int], time: TimeOfDay)
    /// Every this many hours.
    case interval(hours: Int)

    private enum CodingKeys: String, CodingKey {
        case kind, at, time, days, hours
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let kind = try container.decode(String.self, forKey: .kind)
        switch kind {
        case "once":
            self = .once(at: try container.decodeTimestamp(forKey: .at))
        case "daily":
            self = .daily(time: try container.decode(TimeOfDay.self, forKey: .time))
        case "weekly":
            self = .weekly(
                days: try container.decode([Int].self, forKey: .days),
                time: try container.decode(TimeOfDay.self, forKey: .time)
            )
        case "interval":
            self = .interval(hours: try container.decode(Int.self, forKey: .hours))
        default:
            throw DecodingError.dataCorruptedError(
                forKey: .kind,
                in: container,
                debugDescription: "unknown schedule \(kind)"
            )
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .once(at):
            try container.encode("once", forKey: .kind)
            try container.encodeTimestamp(at, forKey: .at)
        case let .daily(time):
            try container.encode("daily", forKey: .kind)
            try container.encode(time, forKey: .time)
        case let .weekly(days, time):
            try container.encode("weekly", forKey: .kind)
            try container.encode(days, forKey: .days)
            try container.encode(time, forKey: .time)
        case let .interval(hours):
            try container.encode("interval", forKey: .kind)
            try container.encode(hours, forKey: .hours)
        }
    }
}
