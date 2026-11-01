import Foundation

/// How one reply of Alfred's divides into messages. The server sends each part as its own message; the app applies the
/// same rule to a draft, so a reply looks the same while it streams as after it lands.
public enum ReplyParts {
    /// The line that divides a reply. It stands alone on its line, with any whitespace around it.
    public static let separator = "<!-- split -->"

    /// The parts of `text`, trimmed, with the empty ones left out. A separator line inside a fenced code block (a run of
    /// three or more backticks or tildes, up to its closing run, or to the end of an unfinished block) is part of the code.
    public static func split(_ text: String) -> [String] {
        scan(text).map(\.text).filter { !$0.isEmpty }
    }

    /// The parts of a reply still being written that a separator line has closed: the part after the last separator is
    /// still growing and is left out. Trimmed, with the empty ones left out, as in `split`.
    public static func finished(_ text: String) -> [String] {
        scan(text).filter(\.isClosed).map(\.text).filter { !$0.isEmpty }
    }

    /// Every part of `text`, trimmed, empty ones included, and whether a separator line follows it.
    private static func scan(_ text: String) -> [(text: String, isClosed: Bool)] {
        var parts: [[Substring]] = [[]]
        var fence: Fence?
        // Foundation splits on the UTF-16 newline, so the "\r" of a CRLF stays on its line (a Swift `Character` joins them).
        for line in text.components(separatedBy: "\n").map({ Substring($0) }) {
            if let open = fence {
                if open.isClosed(by: line) { fence = nil }
            } else if let opened = Fence(opening: line) {
                fence = opened
            } else if line.trimmingCharacters(in: .whitespacesAndNewlines) == separator {
                parts.append([])
                continue
            }
            parts[parts.count - 1].append(line)
        }
        return parts.enumerated().map { index, lines in
            (lines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines), index < parts.count - 1)
        }
    }

    /// A code fence: its character and the length of its run.
    private struct Fence {
        let character: Character
        let length: Int

        init?(opening line: Substring) {
            let line = line.drop { $0 == " " || $0 == "\t" }
            guard let first = line.first, first == "`" || first == "~" else { return nil }
            let run = line.prefix { $0 == first }
            guard run.count >= 3 else { return nil }
            // The info string of a backtick fence has no backtick: otherwise the run is inline code.
            if first == "`", line.dropFirst(run.count).contains("`") { return nil }
            character = first
            length = run.count
        }

        func isClosed(by line: Substring) -> Bool {
            let line = line.drop { $0 == " " || $0 == "\t" }
            let run = line.prefix { $0 == character }
            return run.count >= length && line.dropFirst(run.count).allSatisfy { $0.isWhitespace }
        }
    }
}
