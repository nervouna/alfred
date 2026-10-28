import SwiftUI

/// The colours a message's Markdown is drawn in, by the bubble it is in.
struct MessagePalette {
    var text: Color
    /// The tint, which is what SwiftUI draws a link in.
    var link: Color
    var underlinesLinks: Bool
    /// The quote bars, the quoted text and the rule.
    var quote: Color
    /// Behind a code block and a table.
    var fill: Color

    /// Over the owner's accent-coloured bubble, where a link in the accent colour would not show.
    static var owner: MessagePalette {
        MessagePalette(text: .white, link: .white, underlinesLinks: true, quote: .white.opacity(0.7), fill: .white.opacity(0.18))
    }

    static var alfred: MessagePalette {
        MessagePalette(text: .primary, link: .accentColor, underlinesLinks: false, quote: .secondary, fill: Color(.tertiarySystemBackground))
    }

    var surroundings: SurroundingsColors {
        SurroundingsColors(text: AnyShapeStyle(text), quotedText: AnyShapeStyle(quote), bars: AnyShapeStyle(quote))
    }

    /// The text of a piece as `Text` shows it: a link underlined when the palette says so.
    fileprivate func styled(_ text: AttributedString) -> AttributedString {
        guard underlinesLinks else { return text }
        var text = text
        for range in text.runs.filter({ $0.link != nil }).map(\.range) {
            text[range].underlineStyle = .single
        }
        return text
    }
}

/// A message laid out block by block: headings, paragraphs, lists, quotes, code and tables, each paragraph, heading and
/// table cell one SwiftUI `Text`. Nothing in the chat is annotated, so this is not `PassageText`: it needs no UIKit text
/// view, and a bubble sizes itself to its text.
struct MessageMarkdown: View {
    let blocks: [MarkdownBlock]
    let palette: MessagePalette

    /// The text of a message that is one paragraph outside any list or quote, which is a single `Text`. A message with
    /// no blocks, which is a message of blank lines, is an empty one.
    static func singleText(_ blocks: [MarkdownBlock]) -> AttributedString? {
        guard let block = blocks.first else { return AttributedString() }
        guard blocks.count == 1, block.kind == .paragraph, block.listDepth == 0, block.quoteDepth == 0 else { return nil }
        return block.text
    }

    var body: some View {
        Group {
            if let text = Self.singleText(blocks) {
                Text(palette.styled(text))
                    .font(.body)
            } else {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(blocks) { block in
                        MessageBlockView(block: block, palette: palette)
                    }
                }
            }
        }
        .tint(palette.link)
    }
}

private struct MessageBlockView: View {
    let block: MarkdownBlock
    let palette: MessagePalette

    var body: some View {
        switch block.kind {
        case .thematicBreak:
            Rectangle()
                .fill(palette.quote)
                .frame(height: 1)
                .accessibilityHidden(true)
        case .code:
            // A scroll view's content is not part of the combined element of the bubble: the block speaks for itself.
            surrounded(
                CodeBlock(code: block.text.plainText, palette: palette)
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(block.text.plainText)
            )
        case let .table(table):
            MessageTable(table: table, palette: palette)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(MessageText.plainText([block]).replacing("\t", with: ", "))
        case let .heading(level):
            surrounded(Text(palette.styled(block.text)).font(level == 1 ? .title3.bold() : .headline))
        case .paragraph:
            surrounded(Text(palette.styled(block.text)).font(.body))
        }
    }

    private func surrounded(_ content: some View) -> some View {
        content.modifier(BlockSurroundings(block: block, colors: palette.surroundings))
    }
}

/// Code as it was typed, monospaced and not wrapped, in a horizontal scroll view.
private struct CodeBlock: View {
    let code: String
    let palette: MessagePalette

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Text(code)
                .font(.footnote.monospaced())
                .fixedSize(horizontal: true, vertical: true)
                .padding(8)
        }
        .background(palette.fill, in: RoundedRectangle(cornerRadius: 8))
    }
}

/// A table in a horizontal scroll view, its header cells bold.
private struct MessageTable: View {
    let table: MarkdownTable
    let palette: MessagePalette

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 6) {
                if !table.header.isEmpty {
                    GridRow {
                        ForEach(Array(table.header.enumerated()), id: \.offset) { _, cell in
                            Text(palette.styled(cell)).font(.body.bold())
                        }
                    }
                    Rectangle()
                        .fill(palette.quote)
                        .frame(height: 1)
                        .gridCellUnsizedAxes(.horizontal)
                        .accessibilityHidden(true)
                }
                ForEach(Array(table.rows.enumerated()), id: \.offset) { _, cells in
                    GridRow {
                        ForEach(Array(cells.enumerated()), id: \.offset) { _, cell in
                            Text(palette.styled(cell)).font(.body)
                        }
                    }
                }
            }
            .padding(8)
        }
        .background(palette.fill, in: RoundedRectangle(cornerRadius: 8))
    }
}
