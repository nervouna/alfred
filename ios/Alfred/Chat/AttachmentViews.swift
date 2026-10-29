import PhotosUI
import SwiftUI

/// A file on its way to Alfred: in the composer it can be removed; under a pending message it shows how its upload is.
struct AttachmentChip: View {
    let attachment: Attachment
    /// Set for a chip in the composer: the remove button.
    var onRemove: (() -> Void)?

    var body: some View {
        HStack(spacing: 6) {
            status
                .frame(width: 18, height: 18)
            VStack(alignment: .leading, spacing: 0) {
                Text(attachment.name)
                    .font(.footnote)
                    .lineLimit(1)
                    .truncationMode(.middle)
                if attachment.state == .failed {
                    Text("上传失败")
                        .font(.caption2)
                        .foregroundStyle(.red)
                        .accessibilityIdentifier("attachment.failed")
                }
            }
            if let onRemove {
                Button(action: onRemove) {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("移除 \(attachment.name)")
                .accessibilityIdentifier("attachment.remove")
            }
        }
        .padding(.leading, 10)
        .padding(.trailing, onRemove == nil ? 10 : 6)
        .padding(.vertical, 6)
        .frame(maxWidth: 240, alignment: .leading)
        .background(Color(.tertiarySystemBackground), in: Capsule())
        .overlay(Capsule().stroke(attachment.state == .failed ? Color.red.opacity(0.6) : .clear, lineWidth: 0.5))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("attachment.chip")
    }

    @ViewBuilder
    private var status: some View {
        switch attachment.state {
        case .ready:
            Image(systemName: attachment.isImage ? "photo" : "doc")
                .foregroundStyle(.secondary)
        case let .uploading(fraction):
            if fraction > 0 {
                ProgressView(value: fraction)
                    .progressViewStyle(.circular)
                    .controlSize(.small)
                    .accessibilityLabel("正在上传")
                    .accessibilityValue("\(Int(fraction * 100))%")
            } else {
                ProgressView()
                    .controlSize(.small)
                    .accessibilityLabel("正在上传")
            }
        case .uploaded:
            Image(systemName: "checkmark.circle.fill")
                .foregroundStyle(.green)
        case .failed:
            Image(systemName: "exclamationmark.circle.fill")
                .foregroundStyle(.red)
        }
    }
}

/// The files chosen for the next message, in the composer's field above the text row. The field's shape clips it.
struct AttachmentStrip: View {
    let model: AppModel
    /// Photos being read from the picker, which the model does not know about yet.
    let loadingPhotos: Bool

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(model.draftAttachments) { attachment in
                    AttachmentChip(attachment: attachment) {
                        model.removeAttachment(id: attachment.id)
                    }
                }
                if model.isStaging || loadingPhotos {
                    ProgressView()
                        .controlSize(.small)
                        .padding(.horizontal, 8)
                        .accessibilityIdentifier("attachment.loading")
                }
            }
            .padding(.horizontal, 12)
        }
    }
}

/// A photo the picker exported: the app's own copy of its file, in the format the library holds it in.
struct PickedPhoto: Transferable {
    let url: URL

    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(importedContentType: .image) { received in
            // The received file goes away when this returns, so the app keeps a copy.
            let copy = try AttachmentStaging.newFolder().appending(path: received.file.lastPathComponent)
            try FileManager.default.copyItem(at: received.file, to: copy)
            return PickedPhoto(url: copy)
        }
    }
}
