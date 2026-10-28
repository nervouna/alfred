import AlfredKit
import PhotosUI
import SwiftUI

struct ChatView: View {
    let model: AppModel
    @State private var confirmsUnpairing = false

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
                    ChatHeaderOverlay(state: AvatarState(isWorking: model.runningChatRun != nil), isConnected: model.isConnected)
                }
                // Like the header, a bar: the list's soft edge effect fades the messages out under the composer.
                .safeAreaBar(edge: .bottom, spacing: 0) {
                    Composer(model: model)
                }
                // The header is drawn by hand. The title stays for the back button of the screens this one opens.
                .navigationTitle("对话")
                .toolbar(.hidden, for: .navigationBar)
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
/// writing. The list keeps to the bottom as content arrives.
private struct MessageList: View {
    let model: AppModel
    /// Space above the first message, for the avatar that hangs over the top of the list.
    let topMargin: CGFloat
    /// The rows at least half on screen, by id.
    @State private var visibleIds: Set<String> = []
    private let bottom = "bottom"

    /// How often, and how many times, a tapped notification's row is scrolled to until it is seen.
    private static let revealInterval = Duration.milliseconds(100)
    private static let revealAttempts = 40

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 12) {
                    ForEach(model.timeline.items) { item in
                        switch item {
                        case let .message(message): MessageRow(message: message, taskTitle: model.taskLabel(for: message))
                        case let .question(record): QuestionCard(model: model, record: record)
                        }
                    }
                    ForEach(model.timeline.pending, id: \.clientId) { pending in
                        PendingRow(model: model, pending: pending)
                    }
                    ForEach(model.liveReplies) { reply in
                        LiveReplyRow(reply: reply)
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
            .onChange(of: contentSignature) {
                // A tapped notification's row is being shown: new content must not take the list away from it.
                guard model.revealRequest == nil else { return }
                proxy.scrollTo(bottom, anchor: .bottom)
            }
            .task(id: model.revealRequest) {
                await reveal(model.revealRequest, using: proxy)
            }
        }
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
        model.revealHandled(request)
    }

    /// Changes whenever something is added to the list or grows.
    private var contentSignature: [Int] {
        let live = model.liveReplies
        return [
            model.timeline.messages.count,
            model.timeline.questions.count,
            model.timeline.openQuestions.count,
            model.answerFailures.count,
            model.timeline.pending.count,
            live.count,
            live.reduce(0) { $0 + ($1.text?.utf8.count ?? 0) + ($1.stepText?.utf8.count ?? 0) },
        ]
    }
}

private struct Bubble: View {
    let text: String
    let isOwner: Bool
    let identifier: String

    var body: some View {
        // Parsed on every pass, so a draft that grows is laid out again as it is.
        let blocks = MessageText.blocks(text)
        let palette = isOwner ? MessagePalette.owner : .alfred
        HStack(spacing: 0) {
            if isOwner { Spacer(minLength: 48) }
            MessageMarkdown(blocks: blocks, palette: palette)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .foregroundStyle(palette.text)
                .background(isOwner ? Color.accentColor : Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 16))
                .contextMenu {
                    Button("复制", systemImage: "doc.on.doc") {
                        UIPasteboard.general.string = MessageText.plainText(blocks)
                    }
                }
                .modifier(BubbleAccessibility(isSingleText: MessageMarkdown.singleText(blocks) != nil, identifier: identifier))
            if !isOwner { Spacer(minLength: 48) }
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

/// The reply a run is writing, with the step it is on in secondary text under it.
private struct LiveReplyRow: View {
    let reply: AppModel.LiveReply

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let text = reply.text {
                Bubble(text: text, isOwner: false, identifier: "message.draft")
            }
            if let step = reply.stepText {
                Text(step)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                    .padding(.horizontal, 4)
                    .accessibilityIdentifier("run.step")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
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
