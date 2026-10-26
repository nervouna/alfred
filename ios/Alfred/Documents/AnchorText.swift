import AlfredKit
import Foundation

/// The text a passage annotation anchors on, and where a target finds its place in it.
///
/// For a Markdown document it is the plain text of the blocks `MarkdownDocument` reads, joined with `\n`; for a text
/// document it is the file's text. It is made of pieces, the runs of text the viewer lays out on their own and in which
/// a selection stays: a paragraph, a heading, a list item, a quote, a code block or a table cell (a text document is one
/// piece). A passage never crosses from one piece to the next.
///
/// A passage target holds the selected text as `quote`, and up to `contextLength` characters (Unicode scalars, the way
/// Alfred counts them) before and after it in the joined text as `prefix` and `suffix`, as a W3C TextQuoteSelector
/// does. `locate` finds a target again in the text of any version.
struct AnchorText: Equatable {
    /// How many characters of the text before and after a quote the target keeps.
    static let contextLength = 32

    /// One run of selectable text.
    struct Piece: Hashable, Sendable {
        /// The id of the Markdown block; 0 for a text document.
        let block: Int
        /// The cell of a table in reading order, the header's first; 0 for any other piece.
        let cell: Int

        init(block: Int, cell: Int = 0) {
            self.block = block
            self.cell = cell
        }
    }

    /// Where a target fits: inside one piece, as the UTF-16 range a text view reports a selection in.
    struct Placement: Hashable, Sendable {
        let piece: Piece
        let range: NSRange
    }

    /// A piece's place in the scalars of the joined text.
    private struct Run: Equatable {
        let piece: Piece
        let start: Int
        let end: Int
    }

    /// The scalars of the whole text, the pieces joined with `\n`.
    private let scalars: [Unicode.Scalar]
    private let runs: [Run]
    /// Which text this is, so two of them are told apart without comparing every scalar.
    let id = UUID()

    /// The pieces, in order. A piece's text may be empty.
    init(pieces: [(piece: Piece, text: String)]) {
        var scalars: [Unicode.Scalar] = []
        var runs: [Run] = []
        for (index, entry) in pieces.enumerated() {
            if index > 0 { scalars.append("\n") }
            let start = scalars.count
            scalars.append(contentsOf: entry.text.unicodeScalars)
            runs.append(Run(piece: entry.piece, start: start, end: scalars.count))
        }
        self.scalars = scalars
        self.runs = runs
    }

    /// A text document: the file's text, in one piece.
    init(text: String) {
        self.init(pieces: [(Piece(block: 0), text)])
    }

    /// A Markdown document: the plain text of each block. A table is one piece per cell, and a thematic break an empty piece.
    init(blocks: [MarkdownBlock]) {
        self.init(pieces: blocks.flatMap { block -> [(piece: Piece, text: String)] in
            switch block.kind {
            case let .table(table):
                table.cells.enumerated().map { (Piece(block: block.id, cell: $0.offset), $0.element.plainText) }
            case .thematicBreak:
                [(Piece(block: block.id), "")]
            default:
                [(Piece(block: block.id), block.text.plainText)]
            }
        })
    }

    init(markdown: String) {
        self.init(blocks: MarkdownDocument.blocks(from: markdown))
    }

    static func == (lhs: AnchorText, rhs: AnchorText) -> Bool {
        lhs.id == rhs.id
    }

    /// The whole text, the pieces joined with `\n`.
    var text: String {
        var view = String.UnicodeScalarView()
        view.append(contentsOf: scalars)
        return String(view)
    }

    // MARK: Making a target

    /// The target of a selection of `range` (UTF-16, as a text view reports it) in a piece. `quote` is the text the
    /// view shows there: a selection of something else, of nothing or of white space only makes no target.
    func target(selecting range: NSRange, of quote: String, in piece: Piece) -> AnnotationTarget? {
        guard let run = runs.first(where: { $0.piece == piece }),
              let lower = scalarOffset(utf16: range.location, in: run),
              let upper = scalarOffset(utf16: range.location + range.length, in: run),
              lower < upper
        else { return nil }
        let selected = string(run.start + lower, run.start + upper)
        guard selected == quote, !selected.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        return passage(from: run.start + lower, to: run.start + upper)
    }

    /// The target of a quote that sits at these scalars, with the text around it.
    private func passage(from start: Int, to end: Int) -> AnnotationTarget {
        .passage(
            quote: string(start, end),
            prefix: string(max(0, start - Self.contextLength), start),
            suffix: string(end, min(scalars.count, end + Self.contextLength))
        )
    }

    // MARK: Finding a target

    /// Where a target fits in this text. The candidates are the occurrences of the quote that lie inside one piece; an
    /// occurrence that crosses from one piece to the next is not one. Each is ranked by how much of the prefix ends right
    /// before it plus how much of the suffix starts right after it, counted in characters; the best wins, and a tie goes
    /// to the first. `nil` when the target is a whole-document comment, when the quote does not occur, or when it only
    /// occurs across pieces.
    func locate(_ target: AnnotationTarget) -> Placement? {
        guard case let .passage(quote, prefix, suffix) = target, let found = occurrence(of: quote, prefix: prefix, suffix: suffix) else {
            return nil
        }
        let (run, start, length) = found
        let location = utf16Length(of: scalars[run.start..<start])
        return Placement(piece: run.piece, range: NSRange(location: location, length: utf16Length(of: scalars[start..<(start + length)])))
    }

    /// The target as this text would make it: the same quote with the text around it here. It is how a target that
    /// was made on another version is brought to this one. `nil` when the target does not fit.
    func reanchored(_ target: AnnotationTarget) -> AnnotationTarget? {
        guard case let .passage(quote, prefix, suffix) = target, let (_, start, length) = occurrence(of: quote, prefix: prefix, suffix: suffix) else {
            return nil
        }
        return passage(from: start, to: start + length)
    }

    private func occurrence(of quote: String, prefix: String, suffix: String) -> (run: Run, start: Int, length: Int)? {
        let needle = Array(quote.unicodeScalars)
        guard let first = needle.first else { return nil }
        let before = Array(prefix.unicodeScalars)
        let after = Array(suffix.unicodeScalars)
        var best: (score: Int, run: Run, start: Int)?
        for run in runs where run.end - run.start >= needle.count {
            var start = run.start
            while start + needle.count <= run.end {
                defer { start += 1 }
                guard scalars[start] == first, scalars[start..<(start + needle.count)].elementsEqual(needle) else { continue }
                let score = matchedBefore(start, before) + matchedAfter(start + needle.count, after)
                if best == nil || score > best!.score {
                    best = (score, run, start)
                }
            }
        }
        return best.map { ($0.run, $0.start, needle.count) }
    }

    /// How many of the last scalars of `prefix` end right before `index`.
    private func matchedBefore(_ index: Int, _ prefix: [Unicode.Scalar]) -> Int {
        var count = 0
        while count < prefix.count, index - 1 - count >= 0, scalars[index - 1 - count] == prefix[prefix.count - 1 - count] {
            count += 1
        }
        return count
    }

    /// How many of the first scalars of `suffix` start right at `index`.
    private func matchedAfter(_ index: Int, _ suffix: [Unicode.Scalar]) -> Int {
        var count = 0
        while count < suffix.count, index + count < scalars.count, scalars[index + count] == suffix[count] {
            count += 1
        }
        return count
    }

    // MARK: Offsets

    private func string(_ start: Int, _ end: Int) -> String {
        var view = String.UnicodeScalarView()
        view.append(contentsOf: scalars[start..<end])
        return String(view)
    }

    private func utf16Length(of scalars: ArraySlice<Unicode.Scalar>) -> Int {
        scalars.reduce(0) { $0 + ($1.value > 0xFFFF ? 2 : 1) }
    }

    /// The scalar offset inside a run of a UTF-16 offset; `nil` when the offset is outside the run or splits a surrogate pair.
    private func scalarOffset(utf16 offset: Int, in run: Run) -> Int? {
        guard offset >= 0 else { return nil }
        var units = 0
        var index = run.start
        while units < offset, index < run.end {
            units += scalars[index].value > 0xFFFF ? 2 : 1
            index += 1
        }
        return units == offset ? index - run.start : nil
    }
}

extension MarkdownTable {
    /// Every cell in reading order: the header's, then each row's. A cell's index here is its piece in the anchor text.
    var cells: [AttributedString] {
        header + rows.flatMap { $0 }
    }

    /// The index in `cells` of the cell at a row and column.
    func cellIndex(row: Int, column: Int) -> Int {
        header.count + rows[..<row].reduce(0) { $0 + $1.count } + column
    }
}
