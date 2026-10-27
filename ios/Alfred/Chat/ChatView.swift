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
                // The bar holds only the two buttons and is as tall as the system's own: its scrim ends at its bottom edge.
                .safeAreaBar(edge: .top, spacing: 0) {
                    ChatHeader {
                        confirmsUnpairing = true
                    }
                }
                // Over the bar and the list, and not in the bar's content (see ChatHeader).
                .overlay(alignment: .top) {
                    ChatHeaderOverlay(state: AvatarState(isWorking: model.runningChatRun != nil), isConnected: model.isConnected)
                }
                .safeAreaInset(edge: .bottom, spacing: 0) {
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
            // No edge effect at the top: the scrim behind the bar (ChatHeader) is what the messages show through.
            .scrollEdgeEffectHidden(true, for: .top)
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
        HStack(spacing: 0) {
            if isOwner { Spacer(minLength: 48) }
            Text(MessageText.attributed(text))
                .textSelection(.enabled)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .foregroundStyle(isOwner ? Color.white : Color.primary)
                .background(isOwner ? Color.accentColor : Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 16))
                .accessibilityIdentifier(identifier)
            if !isOwner { Spacer(minLength: 48) }
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
    let model: AppModel
    @State private var text = ""
    @State private var showsPhotoPicker = false
    @State private var showsFileImporter = false
    @State private var pickedPhotos: [PhotosPickerItem] = []
    @State private var loadingPhotos = 0

    private var isBlank: Bool {
        text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var room: Int {
        AttachmentLimits.maxCount - model.draftAttachments.count
    }

    private var canSend: Bool {
        (!isBlank || !model.draftAttachments.isEmpty) && !model.isStaging && loadingPhotos == 0
    }

    var body: some View {
        VStack(spacing: 8) {
            if !model.taskRunBanners.isEmpty {
                TaskRunBanners(model: model)
            }
            if !model.draftAttachments.isEmpty || model.isStaging || loadingPhotos > 0 {
                AttachmentStrip(model: model, loadingPhotos: loadingPhotos > 0)
            }
            HStack(alignment: .bottom, spacing: 8) {
                Menu {
                    Button("照片", systemImage: "photo.on.rectangle") { showsPhotoPicker = true }
                    Button("文件", systemImage: "doc") { showsFileImporter = true }
                } label: {
                    Image(systemName: "plus.circle.fill")
                        .font(.system(size: 32))
                        .foregroundStyle(.secondary)
                }
                .disabled(room <= 0)
                .accessibilityLabel("添加附件")
                TextField("消息", text: $text, axis: .vertical)
                    .lineLimit(1...6)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 18))
                    .accessibilityIdentifier("composer")
                if let run = model.runningChatRun {
                    Button {
                        Task { await model.stop(runId: run.id) }
                    } label: {
                        Image(systemName: "stop.circle.fill")
                            .font(.system(size: 32))
                    }
                    .tint(.red)
                    .accessibilityLabel("停止")
                }
                Button {
                    let sent = text
                    text = ""
                    Task { await model.sendDraft(sent) }
                } label: {
                    Image(systemName: "arrow.up.circle.fill")
                        .font(.system(size: 32))
                }
                .disabled(!canSend)
                .accessibilityLabel("发送")
                .accessibilityIdentifier("send")
            }
        }
        .padding(.horizontal)
        .padding(.vertical, 8)
        .background(.bar)
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
