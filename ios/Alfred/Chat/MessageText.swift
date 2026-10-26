import Foundation

enum MessageText {
    /// A message's text as inline Markdown, with its line breaks and spaces kept. Block syntax such as headings and
    /// lists stays as typed. Text that does not parse shows as it is.
    static func attributed(_ text: String) -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        return (try? AttributedString(markdown: text, options: options)) ?? AttributedString(text)
    }
}
