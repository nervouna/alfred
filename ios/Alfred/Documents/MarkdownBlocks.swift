import Foundation

extension AttributedString {
    var plainText: String { String(characters) }
}

/// A table of a Markdown document.
struct MarkdownTable: Equatable {
    var header: [AttributedString] = []
    var rows: [[AttributedString]] = []
}

/// One block of a Markdown document, as the viewer lays it out.
struct MarkdownBlock: Identifiable, Equatable {
    enum Kind: Equatable {
        case paragraph
        case heading(level: Int)
        case code(language: String?)
        case thematicBreak
        case table(MarkdownTable)
    }

    let id: Int
    var kind: Kind
    /// The block's text with its inline style and links. A code block's text is the code, as it was typed.
    var text = AttributedString()
    /// How many block quotes it is inside.
    var quoteDepth = 0
    /// How many lists it is inside.
    var listDepth = 0
    /// The bullet or number of the list item the block starts; `nil` for any other block, and for the second and
    /// later blocks of one item.
    var marker: String?
}

/// Markdown read into blocks. `AttributedString(markdown:)` with the full syntax gives a flat run of text in which
/// every run says which blocks it belongs to (its `presentationIntent`: a paragraph in a list item in a list, a
/// header, a code block, a table cell). The blocks come from grouping consecutive runs of the same innermost block.
enum MarkdownDocument {
    /// `keepsLineBreaks` turns every soft break, a single newline inside a paragraph, a heading, a list item, a quote or
    /// a table cell, into a `"\n"` instead of a space, as a chat message shows it. A document reads it as a space.
    static func blocks(from markdown: String, keepsLineBreaks: Bool = false) -> [MarkdownBlock] {
        let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .full)
        guard let parsed = try? AttributedString(markdown: markdown, options: options) else {
            return markdown.isEmpty ? [] : [MarkdownBlock(id: 0, kind: .paragraph, text: AttributedString(markdown))]
        }
        var builder = Builder()
        for run in parsed.runs {
            var text = AttributedString(parsed[run.range])
            if keepsLineBreaks, run.inlinePresentationIntent?.contains(.softBreak) == true {
                text.characters.replaceSubrange(text.startIndex..<text.endIndex, with: "\n")
                text.inlinePresentationIntent?.remove(.softBreak)
                if text.inlinePresentationIntent?.isEmpty == true {
                    text.inlinePresentationIntent = nil
                }
            }
            builder.add(text, in: run.presentationIntent?.components ?? [])
        }
        return builder.finish()
    }

    private struct Builder {
        /// A table being collected: its cells by row, in the order the rows appeared.
        struct PendingTable {
            var headerRow: Int?
            var rowOrder: [Int] = []
            var cells: [Int: [Int: AttributedString]] = [:]
        }

        private var blocks: [MarkdownBlock] = []
        /// The identity of the block the next run continues, if it is one.
        private var openBlock: Int?
        /// The list items that already have their marker.
        private var markedItems: Set<Int> = []
        private var tables: [Int: PendingTable] = [:]
        private var tableBlocks: [Int: Int] = [:]

        mutating func add(_ text: AttributedString, in components: [PresentationIntent.IntentType]) {
            guard let innermost = components.first else {
                append(text, to: -1, kind: .paragraph, components: [])
                return
            }
            switch innermost.kind {
            case let .tableCell(column):
                addTableCell(text, column: column, components: components)
            case .thematicBreak:
                openBlock = nil
                blocks.append(MarkdownBlock(id: blocks.count, kind: .thematicBreak))
            case let .header(level):
                append(text, to: innermost.identity, kind: .heading(level: level), components: components)
            case let .codeBlock(language):
                append(text, to: innermost.identity, kind: .code(language: language), components: components)
            default:
                append(text, to: innermost.identity, kind: .paragraph, components: components)
            }
        }

        private mutating func append(_ text: AttributedString, to identity: Int, kind: MarkdownBlock.Kind, components: [PresentationIntent.IntentType]) {
            if openBlock == identity, !blocks.isEmpty {
                blocks[blocks.count - 1].text += text
                return
            }
            openBlock = identity
            var block = MarkdownBlock(id: blocks.count, kind: kind, text: text)
            for component in components {
                switch component.kind {
                case .blockQuote: block.quoteDepth += 1
                case .orderedList, .unorderedList: block.listDepth += 1
                default: break
                }
            }
            block.marker = marker(for: components)
            blocks.append(block)
        }

        /// The marker of the innermost list item, the first time a block of that item is seen.
        private mutating func marker(for components: [PresentationIntent.IntentType]) -> String? {
            guard let index = components.firstIndex(where: { if case .listItem = $0.kind { true } else { false } }),
                  case let .listItem(ordinal) = components[index].kind,
                  markedItems.insert(components[index].identity).inserted
            else { return nil }
            if index + 1 < components.count, case .orderedList = components[index + 1].kind {
                return "\(ordinal)."
            }
            return "•"
        }

        private mutating func addTableCell(_ text: AttributedString, column: Int, components: [PresentationIntent.IntentType]) {
            guard let table = components.first(where: { if case .table = $0.kind { true } else { false } }),
                  let row = components.first(where: {
                      switch $0.kind {
                      case .tableHeaderRow, .tableRow: true
                      default: false
                      }
                  })
            else { return }
            openBlock = nil
            if tableBlocks[table.identity] == nil {
                tableBlocks[table.identity] = blocks.count
                blocks.append(MarkdownBlock(id: blocks.count, kind: .table(MarkdownTable())))
            }
            var pending = tables[table.identity] ?? PendingTable()
            if pending.cells[row.identity] == nil {
                pending.rowOrder.append(row.identity)
                if case .tableHeaderRow = row.kind { pending.headerRow = row.identity }
            }
            pending.cells[row.identity, default: [:]][column, default: AttributedString()] += text
            tables[table.identity] = pending
        }

        mutating func finish() -> [MarkdownBlock] {
            for (identity, index) in tableBlocks {
                guard let pending = tables[identity] else { continue }
                func cells(_ row: Int) -> [AttributedString] {
                    let byColumn = pending.cells[row] ?? [:]
                    return (0..<((byColumn.keys.max() ?? -1) + 1)).map { byColumn[$0] ?? AttributedString() }
                }
                var table = MarkdownTable()
                table.header = pending.headerRow.map(cells) ?? []
                table.rows = pending.rowOrder.filter { $0 != pending.headerRow }.map(cells)
                blocks[index].kind = .table(table)
            }
            return blocks.map { block in
                var block = block
                block.text.presentationIntent = nil
                if case .code = block.kind, block.text.plainText.hasSuffix("\n") {
                    block.text.characters.removeLast()
                }
                return block
            }
        }
    }
}
