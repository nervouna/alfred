/// What a message may carry: at most 10 files of at most 50 MiB each (Alfred's own limits). The app's attachments and
/// the Share Extension's file both keep to them.
enum AttachmentLimits {
    static let maxCount = 10
    static let maxBytes: Int64 = 50 * 1024 * 1024
}
