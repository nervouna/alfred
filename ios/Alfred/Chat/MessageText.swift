import Foundation

enum MessageText {
    /// A message's text as inline Markdown, with its line breaks and spaces kept. Block syntax such as headings and
    /// lists stays as typed. Text that does not parse shows as it is.
    static func attributed(_ text: String) -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        return (try? AttributedString(markdown: text, options: options)) ?? AttributedString(text)
    }

    /// A message's text as Markdown blocks, with its single line breaks kept. Only a link to a web page stays a link:
    /// the parser keeps links of any scheme, and a message must not open a `file:` or an app's own address. The text of
    /// a link that is removed stays.
    static func blocks(_ text: String) -> [MarkdownBlock] {
        MarkdownDocument.blocks(from: text, keepsLineBreaks: true).map { block in
            var block = block
            block.text = keepingWebLinks(block.text)
            if case var .table(table) = block.kind {
                table.header = table.header.map(keepingWebLinks)
                table.rows = table.rows.map { $0.map(keepingWebLinks) }
                block.kind = .table(table)
            }
            return block
        }
    }

    /// The text the blocks show, one block per line, as it goes on the pasteboard. A list item's first block starts with
    /// its marker, a table row is its cells joined by a tab, a code block is its code, and a thematic break is left out.
    static func plainText(_ blocks: [MarkdownBlock]) -> String {
        blocks.compactMap { block -> String? in
            switch block.kind {
            case .thematicBreak:
                nil
            case let .table(table):
                ([table.header] + table.rows)
                    .filter { !$0.isEmpty }
                    .map { $0.map(\.plainText).joined(separator: "\t") }
                    .joined(separator: "\n")
            case .paragraph, .heading, .code:
                (block.marker.map { $0 + " " } ?? "") + block.text.plainText
            }
        }
        .joined(separator: "\n")
    }

    private static func keepingWebLinks(_ text: AttributedString) -> AttributedString {
        let others = text.runs.filter { run in
            guard let link = run.link else { return false }
            return !["http", "https"].contains(link.scheme?.lowercased() ?? "")
        }
        var text = text
        for run in others.reversed() {
            text[run.range].link = nil
        }
        return text
    }
}
