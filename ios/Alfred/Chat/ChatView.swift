import AlfredKit
import SwiftUI

struct ChatView: View {
    let model: AppModel
    @State private var confirmsUnpairing = false

    var body: some View {
        NavigationStack {
            MessageList(model: model)
                .safeAreaInset(edge: .top, spacing: 0) {
                    if !model.isConnected {
                        ConnectingBanner()
                    }
                }
                .safeAreaInset(edge: .bottom, spacing: 0) {
                    Composer(model: model)
                }
                .navigationTitle("对话")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .topBarTrailing) {
                        Menu {
                            Button("取消配对", systemImage: "iphone.slash", role: .destructive) {
                                confirmsUnpairing = true
                            }
                        } label: {
                            Image(systemName: "ellipsis.circle")
                        }
                        .accessibilityLabel("更多")
                    }
                }
                .confirmationDialog("取消配对？", isPresented: $confirmsUnpairing, titleVisibility: .visible) {
                    Button("取消配对", role: .destructive) { model.unpair() }
                }
        }
    }
}

private struct ConnectingBanner: View {
    var body: some View {
        HStack(spacing: 8) {
            ProgressView()
                .controlSize(.small)
            Text("连接中…")
                .font(.footnote)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 6)
        .background(.bar)
    }
}

/// The conversation: stored messages in timeline order, then the owner's pending ones, then what Alfred is
/// writing. The list keeps to the bottom as content arrives.
private struct MessageList: View {
    let model: AppModel
    private let bottom = "bottom"

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 12) {
                    ForEach(model.timeline.messages, id: \.id) { message in
                        MessageRow(message: message)
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
            }
            .defaultScrollAnchor(.bottom)
            .scrollDismissesKeyboard(.interactively)
            .onChange(of: contentSignature) {
                proxy.scrollTo(bottom, anchor: .bottom)
            }
        }
    }

    /// Changes whenever something is added to the list or grows.
    private var contentSignature: [Int] {
        let live = model.liveReplies
        return [
            model.timeline.messages.count,
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

    private var isOwner: Bool { message.direction == .inbound }

    var body: some View {
        VStack(alignment: isOwner ? .trailing : .leading, spacing: 4) {
            if !message.text.isEmpty {
                Bubble(text: message.text, isOwner: isOwner, identifier: (isOwner ? "message.in." : "message.out.") + message.id)
            }
            ForEach(message.files, id: \.path) { file in
                FileChip(file: file)
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

/// A file attached to a message: its name, which opens it in the viewer.
private struct FileChip: View {
    let file: FileRef

    var body: some View {
        NavigationLink {
            FileViewerScreen(path: file.path)
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
            Bubble(text: pending.text, isOwner: true, identifier: "message.pending")
                .opacity(0.5)
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

private struct Composer: View {
    let model: AppModel
    @State private var text = ""

    private var isBlank: Bool {
        text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        HStack(alignment: .bottom, spacing: 8) {
            TextField("消息", text: $text, axis: .vertical)
                .lineLimit(1...6)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 18))
                .accessibilityIdentifier("composer")
            if let run = model.runningTask {
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
                Task { await model.send(sent) }
            } label: {
                Image(systemName: "arrow.up.circle.fill")
                    .font(.system(size: 32))
            }
            .disabled(isBlank)
            .accessibilityLabel("发送")
            .accessibilityIdentifier("send")
        }
        .padding(.horizontal)
        .padding(.vertical, 8)
        .background(.bar)
    }
}
