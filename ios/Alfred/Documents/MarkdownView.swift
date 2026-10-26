import SwiftUI

/// A Markdown document laid out block by block: headings, paragraphs, lists, quotes, code and tables. Images show
/// as their alt text and nothing loads. A link opens in the system browser, and only a web link does. The blocks in
/// `changed` (by id) have a bar at their leading edge, in the accent colour, which VoiceOver reads as 已修改.
///
/// Each run of text is a UIKit text view (`PassageText`) that sets the text the way `Text` did: it is where a selection's
/// range can be read, so the screen around the view can offer 批注 on it and paint what was annotated.
struct MarkdownView: View {
    let blocks: [MarkdownBlock]
    var changed: Set<Int> = []

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 12) {
                ForEach(blocks) { block in
                    MarkdownBlockView(block: block)
                        .overlay(alignment: .leading) {
                            if changed.contains(block.id) {
                                ChangedBar()
                            }
                        }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding()
        }
        .accessibilityIdentifier("viewer.markdown")
    }
}

/// The bar beside a block that changed. It sits in the padding at the leading edge, so the text does not move.
private struct ChangedBar: View {
    var body: some View {
        RoundedRectangle(cornerRadius: 1.5)
            .fill(Color.accentColor)
            .frame(width: 3)
            .offset(x: -10)
            .accessibilityElement()
            .accessibilityLabel("已修改")
            .accessibilityIdentifier("markdown.changed")
    }
}

private struct MarkdownBlockView: View {
    let block: MarkdownBlock

    private static let markerWidth: CGFloat = 24
    private static let indent: CGFloat = 20

    private var piece: AnchorText.Piece {
        AnchorText.Piece(block: block.id)
    }

    private var color: UIColor {
        block.quoteDepth > 0 ? .secondaryLabel : .label
    }

    var body: some View {
        switch block.kind {
        case .thematicBreak:
            Divider()
        case .code:
            ScrollView(.horizontal, showsIndicators: false) {
                PassageText(piece: piece, text: AttributedString(block.text.plainText), style: .code, color: color, wraps: false)
                    .padding(10)
            }
            .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 8))
            .modifier(Surroundings(block: block))
        case let .table(table):
            TableBlock(blockId: block.id, table: table)
        case let .heading(level):
            PassageText(piece: piece, text: block.text, style: .heading(level: level), color: color)
                .modifier(Surroundings(block: block))
        case .paragraph:
            PassageText(piece: piece, text: block.text, color: color)
                .modifier(Surroundings(block: block))
        }
    }

    /// The list indent and marker, and the quote bars, around a block.
    private struct Surroundings: ViewModifier {
        let block: MarkdownBlock

        func body(content: Content) -> some View {
            HStack(alignment: .top, spacing: 8) {
                ForEach(0..<block.quoteDepth, id: \.self) { _ in
                    RoundedRectangle(cornerRadius: 1.5)
                        .fill(.secondary.opacity(0.5))
                        .frame(width: 3)
                }
                if block.listDepth > 0 {
                    HStack(alignment: .top, spacing: 4) {
                        Text(block.marker ?? "")
                            .frame(width: MarkdownBlockView.markerWidth, alignment: .trailing)
                            .accessibilityHidden(block.marker == nil)
                        content
                    }
                    .padding(.leading, CGFloat(block.listDepth - 1) * MarkdownBlockView.indent)
                } else {
                    content
                }
            }
            .foregroundStyle(block.quoteDepth > 0 ? Color.secondary : Color.primary)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

private struct TableBlock: View {
    let blockId: Int
    let table: MarkdownTable

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 6) {
                if !table.header.isEmpty {
                    GridRow {
                        ForEach(Array(table.header.enumerated()), id: \.offset) { column, cell in
                            PassageText(piece: .init(block: blockId, cell: column), text: cell, style: .tableHeader, wraps: false)
                        }
                    }
                    Divider()
                }
                ForEach(Array(table.rows.enumerated()), id: \.offset) { row, cells in
                    GridRow {
                        ForEach(Array(cells.enumerated()), id: \.offset) { column, cell in
                            PassageText(piece: .init(block: blockId, cell: table.cellIndex(row: row, column: column)), text: cell, wraps: false)
                        }
                    }
                }
            }
            .padding(10)
        }
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 8))
    }
}
