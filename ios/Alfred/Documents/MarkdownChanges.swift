import Foundation

/// Which blocks of a Markdown version changed against the version before it. A block is compared by the text
/// `MarkdownDocument` reads from it (its kind with it, because a table's text is in its cells and a heading that
/// became a paragraph has changed), and the blocks of the two versions are matched with a longest common subsequence.
/// A block of the newer version with no match in the older one is marked: it changed, or it is new. A block that
/// only the older version has was removed, and there is nothing left to mark. The match keeps as many blocks in
/// their order as it can, so a block that moved is marked at its new place and the blocks around it are not (when two
/// blocks swap places, one of them is marked).
enum MarkdownChanges {
    /// More cells than this in the table of the match, and the blocks between the common start and end of the two
    /// versions are all marked instead of matched: the table would take hundreds of megabytes.
    static let maxMatchCells = 16_000_000

    /// The ids of the blocks of `current` that changed or were added against `previous`. The first version of a document has
    /// no `previous`, and marks nothing.
    static func changedBlockIds(previous: [MarkdownBlock]?, current: [MarkdownBlock]) -> Set<Int> {
        guard let previous else { return [] }
        let unmatched = unmatchedIndices(previous: previous.map(signature), current: current.map(signature))
        return Set(unmatched.map { current[$0].id })
    }

    /// The same for two Markdown texts.
    static func changedBlockIds(previous: String?, current: String) -> Set<Int> {
        changedBlockIds(previous: previous.map { MarkdownDocument.blocks(from: $0) }, current: MarkdownDocument.blocks(from: current))
    }

    /// What two blocks must share to be the same block: their kind and their text.
    private static func signature(_ block: MarkdownBlock) -> String {
        let separator = "\u{1F}"
        switch block.kind {
        case .paragraph:
            return "p" + separator + block.text.plainText
        case let .heading(level):
            return "h\(level)" + separator + block.text.plainText
        case let .code(language):
            return "c" + (language ?? "") + separator + block.text.plainText
        case .thematicBreak:
            return "hr"
        case let .table(table):
            let rows = ([table.header] + table.rows).map { $0.map(\.plainText).joined(separator: "\u{1E}") }
            return "t" + separator + rows.joined(separator: "\u{1D}")
        }
    }

    /// The indices of `current` that a longest common subsequence of the two lists leaves unmatched. The start and the end
    /// the two lists share are matched first, so an edit in a long document costs only the blocks between them.
    static func unmatchedIndices(previous: [String], current: [String], maxCells: Int = maxMatchCells) -> [Int] {
        var start = 0
        while start < previous.count, start < current.count, previous[start] == current[start] {
            start += 1
        }
        var previousEnd = previous.count
        var currentEnd = current.count
        while previousEnd > start, currentEnd > start, previous[previousEnd - 1] == current[currentEnd - 1] {
            previousEnd -= 1
            currentEnd -= 1
        }
        let old = Array(previous[start..<previousEnd])
        let new = Array(current[start..<currentEnd])
        if old.isEmpty { return Array(start..<currentEnd) }
        if new.isEmpty { return [] }
        if old.count * new.count > maxCells { return Array(start..<currentEnd) }

        // longest[i][j] is the length of a longest common subsequence of old[i...] and new[j...].
        let width = new.count + 1
        var longest = [UInt32](repeating: 0, count: (old.count + 1) * width)
        for i in stride(from: old.count - 1, through: 0, by: -1) {
            for j in stride(from: new.count - 1, through: 0, by: -1) {
                longest[i * width + j] = old[i] == new[j]
                    ? longest[(i + 1) * width + j + 1] + 1
                    : max(longest[(i + 1) * width + j], longest[i * width + j + 1])
            }
        }
        // Walk the table from the start. Where the blocks differ, the older one is dropped unless dropping the newer one
        // keeps a longer match.
        var unmatched: [Int] = []
        var i = 0
        var j = 0
        while j < new.count {
            if i < old.count, old[i] == new[j] {
                i += 1
                j += 1
            } else if i < old.count, longest[(i + 1) * width + j] >= longest[i * width + j + 1] {
                i += 1
            } else {
                unmatched.append(start + j)
                j += 1
            }
        }
        return unmatched
    }
}
