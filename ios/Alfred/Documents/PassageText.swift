import SwiftUI
import UIKit

/// What a viewer needs from the screen around it to let the owner annotate passages: whether selecting text offers 批注,
/// what to paint over which pieces, and where a selection and a tap on a highlight go. A viewer that is not inside a
/// document's screen gets the default: nothing is offered, nothing is painted.
struct PassageAnnotating {
    /// Whether selecting text offers 批注: on the current version of a Markdown or text document.
    var isEnabled = false
    var highlights: [AnchorText.Piece: [PassageHighlight]] = [:]
    /// The owner chose 批注 on a selection: the piece, the range in it (UTF-16) and the selected text.
    var annotate: @MainActor (AnchorText.Piece, NSRange, String) -> Void = { _, _, _ in }
    /// The owner tapped a highlight, named by the id of its draft or annotation.
    var open: @MainActor (String) -> Void = { _ in }
}

extension EnvironmentValues {
    @Entry var passageAnnotating = PassageAnnotating()
}

/// How a piece of text is set.
enum PassageStyle: Hashable {
    case body
    case heading(level: Int)
    /// A code block, monospaced and not wrapped.
    case code
    /// A header cell of a table.
    case tableHeader

    var isHeading: Bool {
        if case .heading = self { true } else { false }
    }

    var font: UIFont {
        switch self {
        case .body:
            return .preferredFont(forTextStyle: .body)
        case let .heading(level):
            switch level {
            case 1: return Self.bold(.title1)
            case 2: return Self.bold(.title2)
            case 3: return Self.bold(.title3)
            default: return .preferredFont(forTextStyle: .headline)
            }
        case .code:
            let size = UIFont.preferredFont(forTextStyle: .footnote).pointSize
            return UIFontMetrics(forTextStyle: .footnote).scaledFont(for: .monospacedSystemFont(ofSize: size, weight: .regular))
        case .tableHeader:
            return Self.bold(.body)
        }
    }

    private static func bold(_ style: UIFont.TextStyle) -> UIFont {
        let font = UIFont.preferredFont(forTextStyle: style)
        return font.fontDescriptor.withSymbolicTraits(.traitBold).map { UIFont(descriptor: $0, size: 0) } ?? font
    }
}

/// A piece of the document's text as UIKit sets it: the font of its style, its inline bold, italic, code, strike-through
/// and web links, and the tints of the highlights over it. The text itself is the characters of `text`, so a range in it
/// is a range in the piece the anchor text holds.
enum PassageAttributedText {
    static let draftTint = UIColor.systemYellow.withAlphaComponent(0.45)
    static let submittedTint = UIColor.systemBlue.withAlphaComponent(0.28)

    static func make(_ text: AttributedString, style: PassageStyle, color: UIColor, highlights: [PassageHighlight]) -> NSAttributedString {
        let base = style.font
        let result = NSMutableAttributedString()
        for run in text.runs {
            let intent = style == .code ? [] : (run.inlinePresentationIntent ?? [])
            var attributes: [NSAttributedString.Key: Any] = [.font: font(base, intent), .foregroundColor: color]
            if intent.contains(.strikethrough) {
                attributes[.strikethroughStyle] = NSUnderlineStyle.single.rawValue
            }
            if let link = run.link, ["http", "https"].contains(link.scheme?.lowercased()) {
                attributes[.link] = link
            }
            result.append(NSAttributedString(string: String(text[run.range].characters), attributes: attributes))
        }
        for highlight in highlights where NSMaxRange(highlight.range) <= result.length {
            let tint = highlight.kind == .draft ? draftTint : submittedTint
            result.addAttribute(.backgroundColor, value: tint, range: highlight.range)
        }
        return result
    }

    private static func font(_ base: UIFont, _ intent: InlinePresentationIntent) -> UIFont {
        var traits = base.fontDescriptor.symbolicTraits
        if intent.contains(.stronglyEmphasized) { traits.insert(.traitBold) }
        if intent.contains(.emphasized) { traits.insert(.traitItalic) }
        if intent.contains(.code) {
            let mono = UIFont.monospacedSystemFont(ofSize: base.pointSize, weight: traits.contains(.traitBold) ? .bold : .regular)
            return UIFontMetrics(forTextStyle: .body).scaledFont(for: mono)
        }
        guard traits != base.fontDescriptor.symbolicTraits, let descriptor = base.fontDescriptor.withSymbolicTraits(traits) else { return base }
        return UIFont(descriptor: descriptor, size: 0)
    }
}

/// The UIKit text view of one piece of the document: read-only and selectable, laid out as the SwiftUI `Text` it replaces
/// was, and the one place where a selection's range can be read. Its edit menu offers 批注 beside the system's actions
/// when the screen allows it, and a tap on a highlight opens it. `PassageTextContainer` holds it and speaks for it to
/// VoiceOver.
final class PassageTextView: UITextView, UITextViewDelegate, UIGestureRecognizerDelegate {
    /// What the view shows, so a pass that changes nothing leaves the selection alone.
    struct Shown: Equatable {
        var text: AttributedString
        var style: PassageStyle
        var color: UIColor
        var highlights: [PassageHighlight]
    }

    var piece = AnchorText.Piece(block: 0)
    var canAnnotate = false
    var annotate: (@MainActor (AnchorText.Piece, NSRange, String) -> Void)?
    var open: (@MainActor (String) -> Void)?
    private(set) var shown: Shown?
    private(set) var isHeading = false
    private(set) var highlights: [PassageHighlight] = []

    init(scrolls: Bool) {
        super.init(frame: .zero, textContainer: nil)
        delegate = self
        isEditable = false
        isSelectable = true
        isScrollEnabled = scrolls
        alwaysBounceVertical = scrolls
        backgroundColor = .clear
        textContainerInset = scrolls ? UIEdgeInsets(top: 12, left: 12, bottom: 12, right: 12) : .zero
        textContainer.lineFragmentPadding = 0
        dataDetectorTypes = []
        adjustsFontForContentSizeCategory = true
        let tap = UITapGestureRecognizer(target: self, action: #selector(tapped(_:)))
        tap.delegate = self
        addGestureRecognizer(tap)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not used")
    }

    /// Sets what the view shows. Nothing changes when it is what it already shows.
    func show(_ next: Shown) {
        guard next != shown else { return }
        shown = next
        isHeading = next.style.isHeading
        highlights = next.highlights
        let selection = selectedRange
        attributedText = PassageAttributedText.make(next.text, style: next.style, color: next.color, highlights: next.highlights)
        if selection.length > 0, NSMaxRange(selection) <= attributedText.length {
            selectedRange = selection
        }
    }

    /// The size the view wants at a width. Without a width (inside a horizontal scroll view) the text is on one line per
    /// line break, and the view is as wide as the longest.
    func fittingSize(width: CGFloat?) -> CGSize {
        if let width, width.isFinite, width > 0 {
            let size = sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude))
            return CGSize(width: width, height: ceil(size.height))
        }
        let unbounded = CGSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        let rect = attributedText.boundingRect(with: unbounded, options: [.usesLineFragmentOrigin, .usesFontLeading], context: nil)
        return CGSize(width: ceil(rect.width) + 1, height: ceil(rect.height))
    }

    // MARK: The edit menu

    func textView(_ textView: UITextView, editMenuForTextIn range: NSRange, suggestedActions: [UIMenuElement]) -> UIMenu? {
        guard canAnnotate, let annotate, range.length > 0, let swiftRange = Range(range, in: textView.text) else {
            return UIMenu(children: suggestedActions)
        }
        let selected = String(textView.text[swiftRange])
        guard !selected.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return UIMenu(children: suggestedActions) }
        let piece = piece
        let action = UIAction(title: "批注", image: UIImage(systemName: "text.bubble")) { [weak self] _ in
            annotate(piece, range, selected)
            self?.selectedTextRange = nil
        }
        return UIMenu(children: [action] + suggestedActions)
    }

    // MARK: Highlights

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
        true
    }

    @objc private func tapped(_ recognizer: UITapGestureRecognizer) {
        guard recognizer.state == .ended, let id = highlight(at: recognizer.location(in: self)) else { return }
        open?(id)
    }

    private func highlight(at point: CGPoint) -> String? {
        highlights.first { highlight in
            rects(of: highlight.range).contains { $0.insetBy(dx: -2, dy: -2).contains(point) }
        }?.id
    }

    /// The rectangles a range of the text takes, in the view's own coordinates.
    func rects(of range: NSRange) -> [CGRect] {
        guard let start = position(from: beginningOfDocument, offset: range.location),
              let end = position(from: start, offset: range.length),
              let textRange = textRange(from: start, to: end)
        else { return [] }
        return selectionRects(for: textRange).map(\.rect).filter { !$0.isEmpty && !$0.isInfinite }
    }

}

/// The view a piece of text is shown in: the text view, and the accessibility around it. The text view is hidden from
/// VoiceOver and from the accessibility tree; the container offers the text as one static text and each highlight as a
/// button read as 草稿 or 修订中 with the words it covers, which opens it when it is activated. The elements are made once
/// and kept, because accessibility clients hold on to them.
final class PassageTextContainer: UIView {
    let textView: PassageTextView
    private lazy var textElement = UIAccessibilityElement(accessibilityContainer: self)
    private var highlightElements: [String: HighlightElement] = [:]

    init(scrolls: Bool) {
        textView = PassageTextView(scrolls: scrolls)
        super.init(frame: .zero)
        textView.frame = bounds
        textView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        textView.accessibilityElementsHidden = true
        addSubview(textView)
        isAccessibilityElement = false
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not used")
    }

    override var accessibilityElements: [Any]? {
        get {
            let content = textView.text ?? ""
            textElement.accessibilityLabel = content
            textElement.accessibilityTraits = textView.isHeading ? [.staticText, .header] : .staticText
            textElement.accessibilityFrameInContainerSpace = bounds
            var elements: [Any] = [textElement]
            var kept: [String: HighlightElement] = [:]
            for highlight in textView.highlights {
                guard NSMaxRange(highlight.range) <= (content as NSString).length, let rect = textView.rects(of: highlight.range).first else { continue }
                let element = highlightElements[highlight.id] ?? HighlightElement(accessibilityContainer: self)
                element.accessibilityLabel = highlight.label
                element.accessibilityValue = (content as NSString).substring(with: highlight.range)
                element.accessibilityTraits = .button
                element.accessibilityIdentifier = "annotation.highlight." + highlight.id
                element.accessibilityFrameInContainerSpace = rect.offsetBy(dx: -textView.contentOffset.x, dy: -textView.contentOffset.y)
                let id = highlight.id
                element.activate = { [weak self] in self?.textView.open?(id) }
                kept[highlight.id] = element
                elements.append(element)
            }
            highlightElements = kept
            return elements
        }
        set {}
    }

    private final class HighlightElement: UIAccessibilityElement {
        var activate: (() -> Void)?

        override func accessibilityActivate() -> Bool {
            guard let activate else { return false }
            activate()
            return true
        }
    }
}

/// One piece of a Markdown document, set as UIKit text so its selection can be read: a paragraph, a heading, a list item,
/// a code block or a table cell. It reads the screen's `PassageAnnotating` from the environment.
struct PassageText: UIViewRepresentable {
    let piece: AnchorText.Piece
    let text: AttributedString
    var style = PassageStyle.body
    var color = UIColor.label
    /// Whether lines wrap at the width given. A code block and a table cell sit in a horizontal scroll view and do not.
    var wraps = true

    func makeUIView(context: Context) -> PassageTextContainer {
        PassageTextContainer(scrolls: false)
    }

    func updateUIView(_ view: PassageTextContainer, context: Context) {
        let annotating = context.environment.passageAnnotating
        view.textView.configure(piece: piece, annotating: annotating)
        view.textView.show(PassageTextView.Shown(text: text, style: style, color: color, highlights: annotating.highlights[piece] ?? []))
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView: PassageTextContainer, context: Context) -> CGSize? {
        uiView.textView.fittingSize(width: wraps ? proposal.width : nil)
    }
}

/// A whole text document, scrollable: one piece.
struct PassageDocumentText: UIViewRepresentable {
    let text: String

    func makeUIView(context: Context) -> PassageTextContainer {
        PassageTextContainer(scrolls: true)
    }

    func updateUIView(_ view: PassageTextContainer, context: Context) {
        let annotating = context.environment.passageAnnotating
        let piece = AnchorText.Piece(block: 0)
        view.textView.configure(piece: piece, annotating: annotating)
        view.textView.show(PassageTextView.Shown(text: AttributedString(text), style: .code, color: .label, highlights: annotating.highlights[piece] ?? []))
    }
}

extension PassageTextView {
    /// What the screen allows on this piece.
    func configure(piece: AnchorText.Piece, annotating: PassageAnnotating) {
        self.piece = piece
        canAnnotate = annotating.isEnabled
        annotate = annotating.annotate
        open = annotating.open
    }
}
