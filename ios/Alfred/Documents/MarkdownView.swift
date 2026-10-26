import SwiftUI

/// A Markdown document laid out block by block: headings, paragraphs, lists, quotes, code and tables. Images show
/// as their alt text and nothing loads. A link opens in the system browser, and only a web link does. The blocks in
/// `changed` (by id) have a bar at their leading edge, in the accent colour, which VoiceOver reads as 已修改.
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
            .textSelection(.enabled)
        }
        .environment(\.openURL, OpenURLAction { url in
            ["http", "https"].contains(url.scheme?.lowercased()) ? .systemAction : .discarded
        })
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

    var body: some View {
        switch block.kind {
        case .thematicBreak:
            Divider()
        case .code:
            ScrollView(.horizontal, showsIndicators: false) {
                Text(block.text.plainText)
                    .font(.system(.footnote, design: .monospaced))
                    .padding(10)
            }
            .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 8))
            .modifier(Surroundings(block: block))
        case let .table(table):
            TableBlock(table: table)
        default:
            text.modifier(Surroundings(block: block))
        }
    }

    @ViewBuilder
    private var text: some View {
        switch block.kind {
        case let .heading(level):
            Text(block.text)
                .font(Self.font(forHeading: level))
                .accessibilityAddTraits(.isHeader)
        default:
            Text(block.text)
        }
    }

    private static func font(forHeading level: Int) -> Font {
        switch level {
        case 1: .title.bold()
        case 2: .title2.bold()
        case 3: .title3.bold()
        default: .headline
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
                    HStack(alignment: .firstTextBaseline, spacing: 4) {
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
    let table: MarkdownTable

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 6) {
                if !table.header.isEmpty {
                    GridRow {
                        ForEach(Array(table.header.enumerated()), id: \.offset) { _, cell in
                            Text(cell).bold()
                        }
                    }
                    Divider()
                }
                ForEach(Array(table.rows.enumerated()), id: \.offset) { _, row in
                    GridRow {
                        ForEach(Array(row.enumerated()), id: \.offset) { _, cell in
                            Text(cell)
                        }
                    }
                }
            }
            .padding(10)
        }
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 8))
    }
}
