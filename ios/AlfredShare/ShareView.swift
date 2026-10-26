import ImageIO
import SwiftUI

/// The sheet: what is shared, a note, and the send. `finish` completes the share request, `cancel` abandons it.
struct ShareView: View {
    @Bindable var model: ShareModel
    let finish: () -> Void
    let cancel: () -> Void

    var body: some View {
        NavigationStack {
            content
                .navigationTitle("Alfred")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button(model.phase == .needsPairing ? "关闭" : "取消", action: cancel)
                            .accessibilityIdentifier("share.cancel")
                    }
                    if model.phase != .needsPairing {
                        ToolbarItem(placement: .confirmationAction) {
                            Button(isFailed ? "重试" : "发送") { Task { await model.send() } }
                                .fontWeight(.semibold)
                                .disabled(!model.canSend)
                                .accessibilityIdentifier("share.send")
                        }
                    }
                }
        }
        .task { await model.start() }
        .onChange(of: model.phase) { _, phase in
            if phase == .sent { finish() }
        }
    }

    @ViewBuilder
    private var content: some View {
        switch model.phase {
        case .loading:
            ProgressView()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .needsPairing:
            Text("请先在 Alfred 里完成配对")
                .multilineTextAlignment(.center)
                .padding()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .accessibilityIdentifier("share.needsPairing")
        case .ready, .sending, .failed, .sent:
            if let shared = model.content {
                Form {
                    Section { SharedPreview(content: shared) }
                    Section {
                        TextField("备注", text: $model.note, axis: .vertical)
                            .lineLimit(1...5)
                            .disabled(isSending)
                            .accessibilityIdentifier("share.note")
                    }
                    status
                }
            } else if case let .failed(reason) = model.phase {
                Text(reason)
                    .multilineTextAlignment(.center)
                    .foregroundStyle(.red)
                    .padding()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .accessibilityIdentifier("share.error")
            }
        }
    }

    @ViewBuilder
    private var status: some View {
        switch model.phase {
        case let .sending(fraction):
            Section {
                if let fraction {
                    ProgressView(value: fraction)
                } else {
                    ProgressView()
                        .frame(maxWidth: .infinity)
                }
            }
        case let .failed(reason):
            Section {
                Text(reason)
                    .foregroundStyle(.red)
                    .accessibilityIdentifier("share.error")
            }
        default:
            EmptyView()
        }
    }

    private var isSending: Bool {
        if case .sending = model.phase { true } else { false }
    }

    private var isFailed: Bool {
        if case .failed = model.phase { true } else { false }
    }
}

/// What is shared: a page's title and address, or a file's name with its picture or icon.
private struct SharedPreview: View {
    let content: SharedContent

    var body: some View {
        switch content {
        case let .page(url, title):
            VStack(alignment: .leading, spacing: 4) {
                if let title {
                    Text(title)
                        .font(.headline)
                        .lineLimit(2)
                }
                Text(url.absoluteString)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
        case let .file(file):
            HStack(spacing: 12) {
                FileThumbnail(file: file)
                Text(file.name)
                    .lineLimit(2)
                    .truncationMode(.middle)
            }
        }
    }
}

/// A small picture of an image, made from the file without reading all of it into memory; the icon for any other file.
private struct FileThumbnail: View {
    let file: StagedShareFile
    @State private var image: UIImage?

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
            } else {
                Image(systemName: file.isImage ? "photo" : "doc.richtext")
                    .font(.title2)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(width: 56, height: 56)
        .background(Color(.secondarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .task { image = file.isImage ? Self.thumbnail(of: file.url) : nil }
    }

    private static func thumbnail(of url: URL) -> UIImage? {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: 168,
        ]
        return CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary).map { UIImage(cgImage: $0) }
    }
}
