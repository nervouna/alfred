import AlfredKit
import SwiftUI

/// A whole message of Alfred's, full screen: the bubble's Markdown, scrollable, with a close button and a copy action.
struct MessageReader: View {
    let blocks: [MarkdownBlock]
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                MessageMarkdown(blocks: blocks, palette: .alfred)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding()
            }
            .accessibilityIdentifier("reader.scroll")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("关闭", systemImage: "xmark") { dismiss() }
                        .accessibilityIdentifier("reader.close")
                }
                ToolbarItem(placement: .primaryAction) {
                    Button("复制", systemImage: "doc.on.doc") {
                        UIPasteboard.general.string = MessageText.plainText(blocks)
                    }
                    .accessibilityIdentifier("reader.copy")
                }
            }
            .navigationBarTitleDisplayMode(.inline)
        }
    }
}
