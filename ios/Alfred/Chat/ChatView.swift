import AlfredKit
import PhotosUI
import SwiftUI

struct ChatView: View {
    let model: AppModel
    @State private var confirmsUnpairing = false
    @State private var showsProfile = false

    var body: some View {
        NavigationStack {
            // The avatar hangs below the bar: the list starts under it.
            MessageList(model: model, topMargin: AvatarMetrics.hang)
                // The bar holds only the two buttons and is as tall as the system's own: the list's soft edge
                // effect ends at its bottom edge.
                .safeAreaBar(edge: .top, spacing: 0) {
                    ChatHeader(
                        isChatRunning: model.runningChatRun != nil,
                        send: { command in Task { await ChatView.choose(command, in: model) } },
                        unpair: { confirmsUnpairing = true }
                    )
                }
                // Over the bar and the list, and not in the bar's content (see ChatHeader).
                .overlay(alignment: .top) {
                    ChatHeaderOverlay(
                        state: AvatarState(isWorking: model.runningChatRun != nil),
                        isConnected: model.isConnected,
                        openProfile: { showsProfile = true }
                    )
                }
                // Like the header, a bar: the list's soft edge effect fades the messages out under the composer.
                .safeAreaBar(edge: .bottom, spacing: 0) {
                    Composer(model: model)
                }
                // The header is drawn by hand. The title stays for the back button of the screens this one opens.
                .navigationTitle("对话")
                .toolbar(.hidden, for: .navigationBar)
                .navigationDestination(isPresented: $showsProfile) {
                    ProfileView()
                }
                .confirmationDialog("取消配对？", isPresented: $confirmsUnpairing, titleVisibility: .visible) {
                    Button("取消配对", role: .destructive) { model.unpair() }
                }
        }
    }

    /// Sends a menu command as the owner's message, as typed. The composer is not touched, so a draft being typed stays.
    @MainActor
    static func choose(_ command: ChatCommand, in model: AppModel) async {
        await model.send(command.text)
    }
}

/// The conversation: stored messages in timeline order, then the owner's pending ones, then what Alfred is
/// writing. The list keeps to the bottom as content arrives, as long as it follows: it stops following when the owner
/// scrolls up, and a button above the composer takes it back to the newest message.
private struct MessageList: View {
    let model: AppModel
    /// Space above the first message, for the avatar that hangs over the top of the list.
    let topMargin: CGFloat
    /// The rows at least half on screen, by id.
    @State private var visibleIds: Set<String> = []
    /// Whether new content takes the list to its end, and the button is hidden. True at first. Only the owner's own
    /// scrolling, the button, the owner sending and a reveal change it: content that arrives, or a container that changes
    /// size (the keyboard, the composer), moves the list's end away from the screen without the owner having left it.
    @State private var follows = true
    /// Whether the list is near its end now, from its geometry. It is kept up to date, and copied into `follows` only at the
    /// moments listed there.
    @State private var isNearEnd = true
    /// Whether the owner's finger is on the list, or the list coasts from a flick.
    @State private var isOwnerScrolling = false
    /// When the bubbles of the reply Alfred is sending show, and the time the list shows them at.
    @State private var pacing = ReplyPacing()
    @State private var now = Date()
    /// The steps the typing bubble last showed. The run's step goes when the run ends, which is often before the last
    /// bubbles of its reply show: the typing bubble keeps them until it goes, so that it does not change height meanwhile.
    @State private var heldSteps: [String] = []
    /// What the list showed when it last followed its end: it follows again only when that changes.
    @State private var followedLayout: ListContent.Layout?
    private let bottom = "bottom"

    /// How often, and how many times, a tapped notification's row is scrolled to until it is seen.
    private static let revealInterval = Duration.milliseconds(100)
    private static let revealAttempts = 40

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                // Each row sets the gap above it: small inside a run of one sender's messages, as in Messages.
                LazyVStack(spacing: 0) {
                    let content = content(at: now)
                    let items = content.items
                    let pending = model.timeline.pending
                    let live = content.live
                    let senders = items.map(sender) + pending.map { _ in RowSender.owner }
                        + live.map { _ in RowSender.alfred } + (content.isTyping ? [RowSender.alfred] : [])
                    ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                        Group {
                            switch item {
                            case let .message(message): MessageRow(message: message, taskTitle: model.taskLabel(for: message))
                            case let .question(record): QuestionCard(model: model, record: record)
                            }
                        }
                        .padding(.top, RowSender.gap(at: index, in: senders))
                        .transition(BubbleArrival.transition)
                    }
                    ForEach(Array(pending.enumerated()), id: \.element.clientId) { index, pending in
                        PendingRow(model: model, pending: pending)
                            .padding(.top, RowSender.gap(at: items.count + index, in: senders))
                    }
                    ForEach(Array(live.enumerated()), id: \.element.runId) { index, content in
                        LiveReplyRow(content: content)
                            .padding(.top, RowSender.gap(at: items.count + pending.count + index, in: senders))
                    }
                    if content.isTyping {
                        TypingRow(steps: content.typingSteps)
                            .padding(.top, RowSender.gap(at: senders.count - 1, in: senders))
                            .transition(BubbleArrival.transition)
                    }
                    Color.clear
                        .frame(height: 1)
                        .id(bottom)
                }
                .padding(.horizontal)
                .padding(.vertical, 12)
                .scrollTargetLayout()
            }
            .contentMargins(.top, topMargin, for: .scrollContent)
            .defaultScrollAnchor(.bottom)
            // The system's soft edge effect at the top: messages blur and fade out under the bar's bottom edge, as in
            // Photos. The composer's bar gets the same at the bottom.
            .scrollEdgeEffectStyle(.soft, for: .top)
            .scrollEdgeEffectStyle(.soft, for: .bottom)
            .scrollDismissesKeyboard(.interactively)
            .onScrollTargetVisibilityChange(idType: String.self, threshold: 0.5) { visibleIds = Set($0) }
            .onScrollGeometryChange(for: Bool.self, of: ListEnd.isNear) { _, isNear in
                isNearEnd = isNear
                if isOwnerScrolling { follows = isNear }
            }
            .onScrollPhaseChange { old, new, context in
                isOwnerScrolling = new.isOwners
                // The owner's scroll starts or ends (a drag, a flick's coasting): where the list is says whether it follows.
                // A scroll the app makes, the button's or a reveal's, is not one.
                if new.isOwners || old.isOwners { follows = ListEnd.isNear(context.geometry) }
            }
            .onScrollGeometryChange(
                for: [CGFloat].self,
                of: { [$0.containerSize.height, $0.contentInsets.bottom, $0.contentSize.height] }
            ) { _, _ in
                // The keyboard or the composer changed the room the list has, or its content grew or shrank: a list that
                // follows keeps its end in view. A bubble of Alfred's grows into the list over a few frames, and the list
                // follows it frame by frame, without an animation of its own (the anchor at the end does not follow
                // content that grows, and an animated scroll aims at an end that has not settled yet).
                guard follows, !isOwnerScrolling, model.revealRequest == nil else { return }
                var transaction = Transaction()
                transaction.disablesAnimations = true
                withTransaction(transaction) { proxy.scrollTo(bottom, anchor: .bottom) }
            }
            .onChange(of: contentSignature, initial: true) { old, new in
                // The owner sent a message: it is shown, and what comes after it is followed.
                if new.pending > old.pending { follows = true }
                // Schedules Alfred's new bubbles and follows the list to its end, once.
                pace(using: proxy)
            }
            .onChange(of: model.liveReplies.compactMap(\.stepText)) { _, steps in
                if !steps.isEmpty { heldSteps = steps }
            }
            .task(id: pacing.nextShow(after: now)) {
                guard let next = pacing.nextShow(after: now) else { return }
                try? await Task.sleep(for: .seconds(max(0, next.timeIntervalSinceNow)))
                guard !Task.isCancelled else { return }
                show(at: .now, revealing: true, using: proxy)
            }
            .task(id: model.revealRequest) {
                await reveal(model.revealRequest, using: proxy)
            }
            .task {
                await followWhenTheOwnerSends()
            }
            .overlay(alignment: .bottom) {
                ZStack {
                    if !follows {
                        Button {
                            follows = true
                            withAnimation { proxy.scrollTo(bottom, anchor: .bottom) }
                        } label: {
                            // The glass style pads its label by 7 pt on every side: 30 + 14 is the 44 pt circle.
                            Image(systemName: "arrow.down")
                                .font(.body.weight(.semibold))
                                .frame(width: 30, height: 30)
                        }
                        .buttonStyle(.glass)
                        .buttonBorderShape(.circle)
                        .padding(.bottom, 12)
                        .transition(.scale.combined(with: .opacity))
                        .accessibilityLabel("回到最新")
                        .accessibilityIdentifier("chat.latest")
                    }
                }
                .animation(.snappy(duration: 0.25), value: follows)
            }
        }
    }

    /// What the list shows at `time`: the timeline without Alfred's messages still being typed, the parts of the drafts
    /// that have shown, and whether Alfred is typing.
    private func content(at time: Date) -> ListContent {
        let replies = ReplyKeys(model.timeline.messages)
        let items = model.timeline.items.filter { item in
            guard case let .message(message) = item, let key = replies.keys[message.id] else { return true }
            return pacing.shows(key, at: time)
        }
        // Each draft's parts after the run's stored messages, with those the draft no longer holds (a stored message took
        // it away) until their own messages land, and the prefix of them that shows.
        let drafts = model.liveReplies.map { reply in
            let offset = replies.counts[reply.runId] ?? 0
            var parts: [String] = []
            while let text = parts.count < reply.parts.count
                ? reply.parts[parts.count]
                : pacing.draftText(ReplyPacing.Key(runId: reply.runId, index: offset + parts.count)) {
                parts.append(text)
            }
            let shown = parts.enumerated().prefix {
                pacing.shows(ReplyPacing.Key(runId: reply.runId, index: offset + $0.offset), at: time)
            }.map(\.element)
            return (reply: reply, parts: parts, shown: shown)
        }
        // Alfred types until every bubble of the reply has shown: the bubble stays between them, so the list does not jump
        // as each one comes.
        let isTyping = model.liveReplies.contains(where: \.isTyping) || pacing.isWaiting(at: time)
            || items.count < model.timeline.items.count || drafts.contains { $0.shown.count < $0.parts.count }
        // The parts of each draft that show, and its step when the typing bubble does not carry it.
        let live = drafts.compactMap { draft -> LiveReplyRow.Content? in
            let step = isTyping ? nil : draft.reply.stepText
            guard !draft.shown.isEmpty || step != nil else { return nil }
            return LiveReplyRow.Content(runId: draft.reply.runId, parts: draft.shown, stepText: step)
        }
        let steps = model.liveReplies.compactMap(\.stepText)
        return ListContent(
            items: items,
            live: live,
            isTyping: isTyping,
            typingSteps: isTyping ? (steps.isEmpty ? heldSteps : steps) : [],
            pending: model.timeline.pending.count
        )
    }

    /// Takes the list to its end, when it follows and no tapped notification's row is being shown.
    private func followEnd(using proxy: ScrollViewProxy) {
        guard model.revealRequest == nil, follows else { return }
        proxy.scrollTo(bottom, anchor: .bottom)
    }

    /// Shows the bubbles due at `time`. One of Alfred's paced bubbles that comes out while the list follows grows into it
    /// in an animation, and the list follows its end frame by frame as it grows (`onScrollGeometryChange`). Anything else
    /// shows at once and takes the list to its end, but only when what the list shows has changed: a draft part that a
    /// stored message replaces, a message that lands while it waits to show, or the run ending under a typing bubble that
    /// stays, would otherwise scroll it in the middle of a bubble's arrival and make it jump.
    private func show(at time: Date, revealing: Bool, using proxy: ScrollViewProxy) {
        let layout = content(at: time).layout
        let moves = layout != followedLayout
        if revealing && follows {
            withAnimation(BubbleArrival.animation) { now = time }
        } else {
            now = time
            if moves { followEnd(using: proxy) }
        }
        followedLayout = layout
        if !pacing.isWaiting(at: time), !model.liveReplies.contains(where: \.isTyping) { heldSteps = [] }
    }

    /// Schedules the bubbles of Alfred's replies that are new: the stored messages of the runs it is typing in, then the
    /// parts of their drafts, which come after them.
    private func pace(using proxy: ScrollViewProxy) {
        let current = Date()
        let replies = ReplyKeys(model.timeline.messages)
        let live = model.liveReplies
        var revealing = false
        for reply in live where reply.isTyping {
            let count = replies.counts[reply.runId] ?? 0
            pacing.follow(reply.runId, existing: (0..<count).map { ReplyPacing.Key(runId: reply.runId, index: $0) })
        }
        for message in model.timeline.messages {
            guard let key = replies.keys[message.id] else { continue }
            if pacing.see(key, length: message.text.count, now: current) { revealing = true }
        }
        for reply in live {
            let offset = replies.counts[reply.runId] ?? 0
            for (index, part) in reply.parts.enumerated() {
                let key = ReplyPacing.Key(runId: reply.runId, index: offset + index)
                if pacing.see(key, length: part.count, now: current) { revealing = true }
                pacing.remember(key, text: part)
            }
        }
        show(at: current, revealing: revealing, using: proxy)
    }

    /// Shows the row a tapped notification names, and holds the request until the row has been seen. One scroll is not
    /// enough: the list is usually new (the tap switched tabs), and a scroll made before it has laid out its rows lands
    /// on an estimate of where the row is, or is overridden by the list's own start at the bottom, and then nothing
    /// corrects it. So it scrolls again, every 100 ms, until the row is on screen at two checks in a row, or 40 tries
    /// have passed.
    private func reveal(_ request: AppModel.RevealRequest?, using proxy: ScrollViewProxy) async {
        guard let request else { return }
        var seen = 0
        for _ in 0..<Self.revealAttempts {
            if visibleIds.contains(request.itemId) {
                seen += 1
                if seen == 2 { break }
            } else {
                seen = 0
                proxy.scrollTo(request.itemId, anchor: .center)
            }
            try? await Task.sleep(for: Self.revealInterval)
            // A newer request, or the list going away, ends this one; the model keeps a request that was not seen.
            if Task.isCancelled { return }
        }
        // The row is where the owner wanted it, which is not the end of the list if it is an old one.
        follows = isNearEnd
        model.revealHandled(request)
    }

    /// Sets `follows` when the owner sends a message. The pending message and its echo can both come before the list draws
    /// again, and the list then sees only the echo, so the pending messages are watched as the model changes, not when the
    /// list draws. The list scrolls once it draws what was sent.
    private func followWhenTheOwnerSends() async {
        var count = model.timeline.pending.count
        for await now in Observations({ model.timeline.pending.count }) {
            if now > count { follows = true }
            count = now
        }
    }

    /// Who a row of the timeline is from. A message under a task's label starts a group of its own.
    private func sender(_ item: TimelineItem) -> RowSender {
        switch item {
        case let .message(message):
            if model.taskLabel(for: message) != nil { return .other }
            return message.direction == .inbound ? .owner : .alfred
        case .question:
            return .other
        }
    }

    /// Changes whenever something is added to the list or grows.
    private var contentSignature: ContentSignature {
        let live = model.liveReplies
        return ContentSignature(
            pending: model.timeline.pending.count,
            rest: [
                model.timeline.messages.count,
                model.timeline.questions.count,
                model.timeline.openQuestions.count,
                model.answerFailures.count,
                live.count,
                live.reduce(0) { $0 + $1.parts.count + ($1.isTyping ? 1 : 0) + ($1.stepText?.utf8.count ?? 0) },
            ]
        )
    }

    /// What `contentSignature` compares: the owner's pending messages apart, since a new one is the owner sending.
    private struct ContentSignature: Equatable {
        let pending: Int
        let rest: [Int]
    }
}

/// The pacing key of each of Alfred's stored messages that a run sent, by message id, and how many each run has sent.
private struct ReplyKeys {
    var keys: [String: ReplyPacing.Key] = [:]
    var counts: [String: Int] = [:]

    init(_ messages: [Message]) {
        for message in messages where message.direction == .outbound {
            guard let runId = message.runId else { continue }
            let index = counts[runId, default: 0]
            keys[message.id] = ReplyPacing.Key(runId: runId, index: index)
            counts[runId] = index + 1
        }
    }
}

/// What the chat's list shows.
private struct ListContent {
    let items: [TimelineItem]
    let live: [LiveReplyRow.Content]
    let isTyping: Bool
    let typingSteps: [String]
    let pending: Int

    /// What changes the list's height at its end: a bubble that shows (a draft part and the stored message that replaces
    /// it count once), a pending message, the typing bubble and its step line.
    struct Layout: Equatable {
        let bubbles: Int
        let isTyping: Bool
        let typingSteps: Int
    }

    var layout: Layout {
        Layout(
            bubbles: items.count + pending + live.reduce(0) { $0 + $1.parts.count + ($1.stepText == nil ? 0 : 1) },
            isTyping: isTyping,
            typingSteps: typingSteps.count
        )
    }
}

/// Who a row of the list is from, for the gap above it.
private enum RowSender: Equatable {
    case owner, alfred
    /// A row that is in no group: a question card, or a message under a task's label.
    case other

    /// The gap between bubbles of one sender in a row.
    static let groupGap: CGFloat = 4
    /// The gap between groups.
    static let gap: CGFloat = 12

    /// The gap above the row at `index`: none above the first, the small one when the row above is from the same sender.
    static func gap(at index: Int, in senders: [RowSender]) -> CGFloat {
        guard index > 0 else { return 0 }
        let sender = senders[index]
        return sender != .other && sender == senders[index - 1] ? groupGap : gap
    }
}

/// Where the end of the list is.
private enum ListEnd {
    /// Whether the end of the content is at most a quarter of the visible height below the bottom of the visible area.
    /// The visible area is the container inside the bars' insets: `visibleRect` reaches under them.
    static func isNear(_ geometry: ScrollGeometry) -> Bool {
        let bottomOfVisibleArea = geometry.visibleRect.maxY - geometry.contentInsets.bottom
        return geometry.contentSize.height - bottomOfVisibleArea <= geometry.containerSize.height / 4
    }
}

private extension ScrollPhase {
    /// The phases of the owner's own scrolling: dragging, and coasting after a flick. Not a scroll the app made.
    var isOwners: Bool { self == .interacting || self == .decelerating }
}

/// How a bubble of Alfred's is cut off when its text is long.
enum BubbleCollapse {
    /// The most lines of body text a bubble of Alfred's shows before it is cut off and opens in the reader.
    static let maxLines = 10
    /// The height of the fade at the cut.
    static let fadeHeight: CGFloat = 40

    /// The height of `maxLines` lines of body text at the current text size.
    static var maxHeight: CGFloat {
        UIFont.preferredFont(forTextStyle: .body).lineHeight * CGFloat(maxLines)
    }
}

/// Proposes its one subview its ideal height, and is itself as high as that or `limit`, whichever is less, with the subview
/// at the top: whatever is below the limit is cut off by the mask. A nil limit never cuts.
private struct CollapsingLayout: Layout {
    let limit: CGFloat?

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        guard let subview = subviews.first else { return .zero }
        let ideal = subview.sizeThatFits(ProposedViewSize(width: proposal.width, height: nil))
        return CGSize(width: ideal.width, height: limit.map { min(ideal.height, $0) } ?? ideal.height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        guard let subview = subviews.first else { return }
        let ideal = subview.sizeThatFits(ProposedViewSize(width: bounds.width, height: nil))
        subview.place(at: bounds.origin, anchor: .topLeading, proposal: ProposedViewSize(width: bounds.width, height: ideal.height))
    }
}

private struct Bubble: View {
    let text: String
    let isOwner: Bool
    let identifier: String
    /// The height the text would take without the cut, measured from the laid-out text.
    @State private var fullHeight: CGFloat = 0
    @State private var showsReader = false
    /// Read so that the cut follows a change of the text size.
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        // Parsed on every pass, so a draft that grows is laid out again as it is.
        let blocks = MessageText.blocks(text)
        let palette = isOwner ? MessagePalette.owner : .alfred
        let _ = dynamicTypeSize
        let limit = BubbleCollapse.maxHeight
        // Alfred's bubbles collapse, the owner's never do. The half point keeps a text of exactly the limit whole.
        let isCollapsed = !isOwner && fullHeight > limit + 0.5
        HStack(spacing: 0) {
            if isOwner { Spacer(minLength: 48) }
            // The layout gives the bubble its height, the text's own or the limit, in the same pass as the text is laid
            // out: a bubble the list creates while the owner scrolls is never taller for a moment than it ends up.
            CollapsingLayout(limit: isOwner ? nil : limit) {
                MessageMarkdown(blocks: blocks, palette: palette)
                    // Measured for the mask and the tap only: nothing is sized from it.
                    .onGeometryChange(for: CGFloat.self, of: { $0.size.height }) { fullHeight = $0 }
            }
                .mask { fade(isCollapsed: isCollapsed, limit: limit) }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .foregroundStyle(palette.text)
                .background(isOwner ? Color.accentColor : Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 16))
                .contentShape(RoundedRectangle(cornerRadius: 16))
                .onTapGesture {
                    if isCollapsed { showsReader = true }
                }
                .contextMenu {
                    Button("复制", systemImage: "doc.on.doc") {
                        UIPasteboard.general.string = MessageText.plainText(blocks)
                    }
                }
                .modifier(BubbleAccessibility(isSingleText: MessageMarkdown.singleText(blocks) != nil, identifier: identifier))
                .modifier(CollapsedAccessibility(isCollapsed: isCollapsed))
                .fullScreenCover(isPresented: $showsReader) {
                    MessageReader(blocks: blocks)
                }
            if !isOwner { Spacer(minLength: 48) }
        }
    }

    /// Opaque, and at the cut fading out over its last `fadeHeight`.
    private func fade(isCollapsed: Bool, limit: CGFloat) -> some View {
        let start = isCollapsed ? max(0, 1 - BubbleCollapse.fadeHeight / limit) : 1
        return LinearGradient(
            stops: [.init(color: .black, location: start), .init(color: isCollapsed ? .clear : .black, location: 1)],
            startPoint: .top,
            endPoint: .bottom
        )
    }
}

/// A collapsed bubble says it opens: its text stays whole for VoiceOver.
private struct CollapsedAccessibility: ViewModifier {
    let isCollapsed: Bool

    func body(content: Content) -> some View {
        if isCollapsed {
            content
                .accessibilityAddTraits(.isButton)
                .accessibilityHint("打开全文")
        } else {
            content
        }
    }
}

/// A message of one paragraph stays a `Text`, which carries the identifier. Any other is one element for VoiceOver and
/// the UI tests, with the text of its blocks as its label.
private struct BubbleAccessibility: ViewModifier {
    let isSingleText: Bool
    let identifier: String

    func body(content: Content) -> some View {
        if isSingleText {
            content.accessibilityIdentifier(identifier)
        } else {
            content
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier(identifier)
        }
    }
}

private struct MessageRow: View {
    let message: Message
    /// The title of the task whose run delivered the message, when the app knows the task.
    let taskTitle: String?

    private var isOwner: Bool { message.direction == .inbound }

    var body: some View {
        VStack(alignment: isOwner ? .trailing : .leading, spacing: 4) {
            if let taskTitle {
                TaskLabel(title: taskTitle, identifier: "message.task." + message.id)
            }
            if !message.text.isEmpty {
                Bubble(text: message.text, isOwner: isOwner, identifier: (isOwner ? "message.in." : "message.out.") + message.id)
            }
            ForEach(message.files, id: \.path) { file in
                FileChip(file: file, message: message)
            }
            if message.channel == .wechat || failedOnWeChat {
                HStack(spacing: 6) {
                    if message.channel == .wechat {
                        Tag(text: "微信", color: .secondary)
                    }
                    if failedOnWeChat {
                        Tag(text: "微信未送达", color: .red)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: isOwner ? .trailing : .leading)
    }

    private var failedOnWeChat: Bool {
        message.direction == .outbound && message.error != nil
    }
}

/// The task a message came from, small, above its bubble.
private struct TaskLabel: View {
    let title: String
    let identifier: String

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: "checklist")
                .accessibilityHidden(true)
            Text(title)
                .lineLimit(1)
        }
        .font(.caption)
        .foregroundStyle(.secondary)
        .padding(.horizontal, 4)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier(identifier)
    }
}

private struct Tag: View {
    let text: String
    let color: Color

    var body: some View {
        Text(text)
            .font(.caption2)
            .foregroundStyle(color)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .overlay(Capsule().stroke(color.opacity(0.6), lineWidth: 0.5))
    }
}

/// A file attached to a message: its name, which opens it. A file of Alfred's message that names a document opens the
/// document at the version the message delivered; any other file opens in the viewer.
private struct FileChip: View {
    let file: FileRef
    let message: Message

    var body: some View {
        NavigationLink {
            target
        } label: {
            Label(URL(filePath: file.path).lastPathComponent, systemImage: symbol)
                .font(.footnote)
                .lineLimit(1)
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(Color(.tertiarySystemBackground), in: Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("file.chip.\(file.path)")
    }

    @ViewBuilder
    private var target: some View {
        switch DocumentPresentation.FileTarget(file: file, in: message) {
        case let .file(path):
            FileViewerScreen(path: path)
        case let .document(id, version):
            DocumentScreen(documentId: id, version: version)
        }
    }

    private var symbol: String {
        switch file.kind {
        case .image: "photo"
        case .voice: "waveform"
        case .video: "video"
        default: "doc"
        }
    }
}

/// A message the server has not stored yet: dimmed, and tappable to send again once its send failed.
private struct PendingRow: View {
    let model: AppModel
    let pending: PendingMessage

    private var failed: Bool { model.failedClientIds.contains(pending.clientId) }

    var body: some View {
        VStack(alignment: .trailing, spacing: 4) {
            if !pending.text.isEmpty {
                Bubble(text: pending.text, isOwner: true, identifier: "message.pending")
                    .opacity(0.5)
            }
            ForEach(model.outgoingAttachments[pending.clientId] ?? []) { attachment in
                AttachmentChip(attachment: attachment)
            }
            if failed {
                Text("发送失败，点按重试")
                    .font(.caption)
                    .foregroundStyle(.red)
            }
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
        .contentShape(Rectangle())
        .onTapGesture {
            guard failed else { return }
            Task { await model.retry(clientId: pending.clientId) }
        }
        .accessibilityAddTraits(failed ? .isButton : [])
    }
}

/// The parts of the reply a run is writing that have shown, each a whole bubble, as the messages will be once they land;
/// and the step the run is on in secondary text under them, when the typing bubble does not carry it.
private struct LiveReplyRow: View {
    struct Content {
        let runId: String
        let parts: [String]
        let stepText: String?
    }

    let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: RowSender.groupGap) {
            ForEach(Array(content.parts.enumerated()), id: \.offset) { index, part in
                Bubble(text: part, isOwner: false, identifier: index == 0 ? "message.draft" : "message.draft.\(index)")
                    .transition(BubbleArrival.transition)
            }
            if let step = content.stepText {
                StepText(text: step)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .animation(BubbleArrival.animation, value: content.parts.count)
    }
}

/// How one of Alfred's bubbles comes out: its row grows from nothing as the bubble rises into it and fades in, with no
/// bounce, which in the list reads as the list jumping.
private enum BubbleArrival {
    static let animation = Animation.smooth(duration: 0.35)
    static var transition: AnyTransition {
        .modifier(active: Growing(fraction: 0), identity: Growing(fraction: 1))
    }
}

/// A row that takes `fraction` of its height, showing its bottom part as it rises into place, and fades in with it. As a
/// transition it grows the list's content frame by frame: the lazy stack's first guess at a new row's height, which it
/// corrects in the next pass, then moves the list by a fraction of nothing.
nonisolated private struct Growing: ViewModifier, Animatable {
    var fraction: CGFloat

    var animatableData: CGFloat {
        get { fraction }
        set { fraction = newValue }
    }

    func body(content: Content) -> some View {
        GrowingLayout(fraction: fraction) { content }
            .clipShape(GrowingClip(isGrowing: fraction < 1))
            .opacity(fraction)
    }
}

/// The row's bounds while it grows, and nothing clipped once it has: a shape, not a modifier that comes and goes, so that
/// the row keeps its identity when the transition ends.
private struct GrowingClip: Shape {
    let isGrowing: Bool

    func path(in rect: CGRect) -> Path {
        Path(isGrowing ? rect : rect.insetBy(dx: -rect.width, dy: -rect.height))
    }
}

private struct GrowingLayout: Layout {
    let fraction: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        guard let subview = subviews.first else { return .zero }
        let size = subview.sizeThatFits(proposal)
        return CGSize(width: size.width, height: size.height * fraction)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        guard let subview = subviews.first else { return }
        let full = subview.sizeThatFits(ProposedViewSize(width: bounds.width, height: nil))
        subview.place(
            at: CGPoint(x: bounds.minX, y: bounds.maxY),
            anchor: .bottomLeading,
            proposal: ProposedViewSize(width: bounds.width, height: full.height)
        )
    }
}

/// Alfred typing, at the end of the list, with the step its run is on under it, on one line so that the row keeps its
/// height as the steps change.
private struct TypingRow: View {
    let steps: [String]

    var body: some View {
        VStack(alignment: .leading, spacing: RowSender.groupGap) {
            TypingBubble()
            ForEach(steps, id: \.self) { StepText(text: $0, lines: 1) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// The step a run is on, in secondary text.
private struct StepText: View {
    let text: String
    var lines = 2

    var body: some View {
        Text(text)
            .font(.footnote)
            .foregroundStyle(.secondary)
            .lineLimit(lines)
            .truncationMode(.middle)
            .padding(.horizontal, 4)
            .accessibilityIdentifier("run.step")
    }
}

/// Three dots that pulse in turn in one of Alfred's bubbles: Alfred is writing. Still when the owner reduces motion.
private struct TypingBubble: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private static let dot: CGFloat = 8
    private static let period = 1.2

    var body: some View {
        TimelineView(.animation(minimumInterval: 1 / 30, paused: reduceMotion)) { context in
            let time = context.date.timeIntervalSinceReferenceDate
            HStack(spacing: 5) {
                ForEach(0..<3, id: \.self) { index in
                    let level = reduceMotion ? 0.5 : Self.level(at: time, dot: index)
                    Circle()
                        .frame(width: Self.dot, height: Self.dot)
                        .opacity(0.35 + 0.65 * level)
                        .offset(y: -2 * level)
                }
            }
        }
        .foregroundStyle(.secondary)
        .padding(.horizontal, 14)
        .padding(.vertical, 13)
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 16))
        .accessibilityElement()
        .accessibilityLabel("Alfred 正在输入")
        .accessibilityIdentifier("chat.typing")
    }

    /// How far a dot is into its pulse, 0 to 1: each dot a third of a period after the one before.
    private static func level(at time: TimeInterval, dot: Int) -> Double {
        let phase = (time / period - Double(dot) / 3).truncatingRemainder(dividingBy: 1)
        return max(0, sin(phase * 2 * .pi))
    }
}

/// The scheduled task runs that are running, one thin row each above the composer, with the run's latest step under the
/// title. A row opens the run's detail, which has its own stop.
private struct TaskRunBanners: View {
    let model: AppModel

    var body: some View {
        VStack(spacing: 4) {
            ForEach(model.taskRunBanners) { banner in
                NavigationLink {
                    RunDetailView(runId: banner.runId)
                } label: {
                    HStack(spacing: 8) {
                        Image(systemName: "checklist")
                            .accessibilityHidden(true)
                        VStack(alignment: .leading, spacing: 2) {
                            Text("定时任务「\(banner.title)」运行中")
                                .lineLimit(1)
                            if let step = banner.stepText {
                                Text(step)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                            }
                        }
                        Spacer(minLength: 0)
                        Image(systemName: "chevron.right")
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(.secondary)
                            .accessibilityHidden(true)
                    }
                    .font(.footnote)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 10))
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("taskRunBanner")
            }
        }
        .frame(maxWidth: .infinity)
    }
}

private struct Composer: View {
    /// The text being typed is the model's (`composerText`), so 讨论 can add an idea to it from another tab.
    @Bindable var model: AppModel
    @State private var showsPhotoPicker = false
    @State private var showsFileImporter = false
    @State private var pickedPhotos: [PhotosPickerItem] = []
    @State private var loadingPhotos = 0
    @FocusState private var isFocused: Bool

    private var isBlank: Bool {
        model.composerText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var room: Int {
        AttachmentLimits.maxCount - model.draftAttachments.count
    }

    private var canSend: Bool {
        (!isBlank || !model.draftAttachments.isEmpty) && !model.isStaging && loadingPhotos == 0
    }

    private var hasStrip: Bool {
        !model.draftAttachments.isEmpty || model.isStaging || loadingPhotos > 0
    }

    var body: some View {
        VStack(spacing: 8) {
            if !model.taskRunBanners.isEmpty {
                TaskRunBanners(model: model)
            }
            field
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .photosPicker(
            isPresented: $showsPhotoPicker,
            selection: $pickedPhotos,
            maxSelectionCount: max(room, 1),
            matching: .images
        )
        .fileImporter(isPresented: $showsFileImporter, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            switch result {
            case let .success(urls):
                Task { await model.attach(urls.map(AttachmentInput.file)) }
            case let .failure(error):
                if (error as? CocoaError)?.code != .userCancelled {
                    model.actionFailure = "无法打开所选文件"
                }
            }
        }
        .onChange(of: pickedPhotos) { _, items in
            guard !items.isEmpty else { return }
            pickedPhotos = []
            Task { await attachPhotos(items) }
        }
    }

    /// The height of a line of the field, which is also the tap target of the buttons in it.
    private static let rowHeight: CGFloat = 44
    private static let cornerRadius: CGFloat = 22

    /// One glass shape holding, top to bottom, the chosen files (only while there are some) and a row of the attach
    /// button, the text and the send button. A single line is as high as the row, which makes the shape a capsule; more
    /// lines make it a rounded rectangle with the same radius. Nothing inside is glass: the shape alone is.
    private var field: some View {
        VStack(spacing: 0) {
            if hasStrip {
                AttachmentStrip(model: model, loadingPhotos: loadingPhotos > 0)
                    .padding(.top, 8)
            }
            HStack(alignment: .bottom, spacing: 0) {
                attachButton
                TextField("消息", text: $model.composerText, axis: .vertical)
                    .lineLimit(1...6)
                    .textFieldStyle(.plain)
                    .focused($isFocused)
                    .padding(.vertical, 10)
                    .frame(minHeight: Self.rowHeight)
                    // The whole row takes the tap, not only the line of text in it.
                    .contentShape(.rect)
                    .onTapGesture { isFocused = true }
                    .accessibilityIdentifier("composer")
                sendSlot
            }
        }
        .clipShape(.rect(cornerRadius: Self.cornerRadius))
        .glassEffect(.regular.interactive(), in: .rect(cornerRadius: Self.cornerRadius))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("composer.field")
    }

    private var attachButton: some View {
        Menu {
            Button("照片", systemImage: "photo.on.rectangle") { showsPhotoPicker = true }
            Button("文件", systemImage: "doc") { showsFileImporter = true }
        } label: {
            Image(systemName: "plus")
                .font(.system(size: 20, weight: .medium))
                .foregroundStyle(.secondary)
                .frame(width: Self.rowHeight, height: Self.rowHeight)
                .contentShape(.rect)
        }
        // A menu draws its label in the tint, which is the accent colour; the plus is secondary.
        .tint(.secondary)
        .disabled(room <= 0)
        .accessibilityLabel("添加附件")
    }

    /// The send button's place at the trailing edge, as wide as the button so that the text does not reflow when the
    /// button comes and goes. The button is there only while there is something to send.
    private var sendSlot: some View {
        ZStack {
            if canSend {
                Button {
                    let sent = model.composerText
                    model.composerText = ""
                    Self.resetFocusedTextView()
                    Task { await model.sendDraft(sent) }
                } label: {
                    Image(systemName: "arrow.up")
                        .font(.system(size: 16, weight: .bold))
                        .foregroundStyle(.white)
                        .frame(width: 32, height: 32)
                        .background(Color.accentColor, in: .circle)
                        .frame(width: Self.rowHeight, height: Self.rowHeight)
                        .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("发送")
                .accessibilityIdentifier("send")
                .transition(.scale.combined(with: .opacity))
            }
        }
        .frame(width: Self.rowHeight, height: Self.rowHeight)
        .animation(.easeOut(duration: 0.15), value: canSend)
    }

    /// Empties the text view that holds focus, through UIKit. After an input method committed text (a picked candidate,
    /// a dictation result) the text view can still hold it when SwiftUI writes `""` into it, and then pushes it back
    /// into the binding. Setting the text on the view itself makes the input system drop its state for the old text,
    /// and the view keeps focus, so the keyboard stays up.
    private static func resetFocusedTextView() {
        let windows = UIApplication.shared.connectedScenes.compactMap { ($0 as? UIWindowScene)?.windows }.joined()
        for window in windows {
            guard let textView = firstResponderTextView(in: window) else { continue }
            textView.unmarkText()
            textView.text = ""
            return
        }
    }

    private static func firstResponderTextView(in view: UIView) -> UITextView? {
        if let textView = view as? UITextView, textView.isFirstResponder { return textView }
        for subview in view.subviews {
            if let found = firstResponderTextView(in: subview) { return found }
        }
        return nil
    }

    /// Reads the photos the picker chose into the app and attaches them.
    private func attachPhotos(_ items: [PhotosPickerItem]) async {
        loadingPhotos += 1
        defer { loadingPhotos -= 1 }
        var inputs: [AttachmentInput] = []
        var unreadable = 0
        for item in items {
            if let photo = try? await item.loadTransferable(type: PickedPhoto.self) {
                inputs.append(.photo(photo.url))
            } else {
                unreadable += 1
            }
        }
        await model.attach(inputs)
        if unreadable > 0 {
            model.actionFailure = [model.actionFailure, "有 \(unreadable) 张照片无法读取"].compactMap { $0 }.joined(separator: "\n")
        }
    }
}
