/// One server-sent event, as the WHATWG rules dispatch it. `data` is its data lines joined with newlines.
public struct SSEFrame: Hashable, Sendable {
    public let id: String?
    public let event: String?
    public let data: String

    public init(id: String?, event: String?, data: String) {
        self.id = id
        self.event = event
        self.data = data
    }
}

/// What the parser reports: a dispatched frame, or a comment line (such as `: ping`), which is a heartbeat.
public enum SSEItem: Hashable, Sendable {
    case frame(SSEFrame)
    case heartbeat
}

/// A parser for `text/event-stream` that is fed bytes as they arrive. Lines end in LF, CRLF or CR. A line that starts
/// with a colon is a comment and is reported as a heartbeat; an empty line dispatches the frame, if it has data.
public struct SSEParser: Sendable {
    private static let lf: UInt8 = 0x0A
    private static let cr: UInt8 = 0x0D
    private static let colon: UInt8 = 0x3A
    private static let space: UInt8 = 0x20

    private var line: [UInt8] = []
    /// After a CR, an LF is the rest of the same line break.
    private var skipLF = false
    private var id: String?
    private var event: String?
    private var dataLines: [String] = []

    public init() {}

    /// Feeds one byte. A line break completes at most one item, so one byte yields at most one item.
    public mutating func feed(_ byte: UInt8) -> SSEItem? {
        if skipLF {
            skipLF = false
            if byte == Self.lf { return nil }
        }
        guard byte == Self.lf || byte == Self.cr else {
            line.append(byte)
            return nil
        }
        skipLF = byte == Self.cr
        let completed = endLine(line)
        line.removeAll(keepingCapacity: true)
        return completed
    }

    /// Feeds many bytes and returns the items they complete, in order.
    public mutating func feed<Bytes: Sequence>(contentsOf bytes: Bytes) -> [SSEItem] where Bytes.Element == UInt8 {
        var items: [SSEItem] = []
        for byte in bytes {
            if let item = feed(byte) { items.append(item) }
        }
        return items
    }

    private mutating func endLine(_ bytes: [UInt8]) -> SSEItem? {
        if bytes.isEmpty {
            return dispatch()
        }
        if bytes[0] == Self.colon {
            return .heartbeat
        }
        let name: String
        var value: ArraySlice<UInt8> = []
        if let colon = bytes.firstIndex(of: Self.colon) {
            name = String(decoding: bytes[..<colon], as: UTF8.self)
            value = bytes[(colon + 1)...]
            if value.first == Self.space {
                value = value.dropFirst()
            }
        } else {
            name = String(decoding: bytes, as: UTF8.self)
        }
        let text = String(decoding: value, as: UTF8.self)
        switch name {
        case "event":
            event = text
        case "data":
            dataLines.append(text)
        case "id":
            if !text.contains("\u{0}") { id = text }
        default:
            break
        }
        return nil
    }

    /// Ends the frame in progress. Fields belong to their frame only, so they are cleared whether or not it dispatches.
    private mutating func dispatch() -> SSEItem? {
        defer {
            id = nil
            event = nil
            dataLines = []
        }
        guard !dataLines.isEmpty else { return nil }
        return .frame(SSEFrame(id: id, event: event, data: dataLines.joined(separator: "\n")))
    }
}
