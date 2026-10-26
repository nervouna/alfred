import AlfredKit
import Foundation
import Observation

/// What the Share Extension's sheet shows and does: whether the device is paired, what was shared, the owner's note,
/// and the send. A page goes out as one message. A file is uploaded first, then sent as a message that names it, and a
/// retry after a failure does not upload a file that is already saved.
@MainActor
@Observable
final class ShareModel {
    enum Phase: Equatable {
        /// Reading the credentials and what was shared.
        case loading
        /// The app has not paired, or the keychain does not give this extension its credentials.
        case needsPairing
        case ready
        /// The fraction of an upload sent so far, when there is one.
        case sending(Double?)
        /// The reason the last attempt failed. `send` tries again.
        case failed(String)
        case sent
    }

    /// A page's title is cut to this many characters, so a long one cannot push the message over Alfred's limit.
    static let titleLimit = 300

    private(set) var phase = Phase.loading
    private(set) var content: SharedContent?
    var note = ""

    @ObservationIgnored private let store: any CredentialStore
    @ObservationIgnored private let session: URLSession
    @ObservationIgnored private let loader: @MainActor () async throws -> SharedContent
    /// One id for the share, so a send that is repeated after a lost answer is not stored twice.
    @ObservationIgnored private let clientId: String
    @ObservationIgnored private var credentials: Credentials?
    /// The file Alfred saved, once the upload is done.
    @ObservationIgnored private var uploaded: FileRef?

    init(
        store: any CredentialStore,
        session: URLSession = .shared,
        loader: @escaping @MainActor () async throws -> SharedContent,
        makeClientId: () -> String = { "c-" + UUID().uuidString.lowercased() }
    ) {
        self.store = store
        self.session = session
        self.loader = loader
        clientId = makeClientId()
    }

    /// Whether the send button does anything.
    var canSend: Bool {
        guard content != nil else { return false }
        switch phase {
        case .ready, .failed: return true
        case .loading, .needsPairing, .sending, .sent: return false
        }
    }

    /// Reads the credentials and, when there are some, what was shared.
    func start() async {
        guard phase == .loading else { return }
        credentials = try? store.load()
        guard credentials != nil else {
            phase = .needsPairing
            return
        }
        do {
            content = try await loader()
            phase = .ready
        } catch {
            phase = .failed(Self.message(for: error))
        }
    }

    /// Sends what was shared with the note. On a failure the phase says why and a new call tries again.
    func send() async {
        guard canSend, let content, let credentials else { return }
        phase = .sending(nil)
        let client = AlfredClient(credentials: credentials, session: session)
        let note = self.note.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            switch content {
            case let .page(url, title):
                let text = Self.pageText(url: url, title: title, note: note)
                try await client.send(.messageSend(clientId: clientId, text: text))
            case let .file(file):
                let saved = try await save(file, using: client)
                try await client.send(.messageSend(clientId: clientId, text: note, files: [saved]))
            }
            phase = .sent
            discard()
        } catch {
            phase = .failed(Self.message(for: error))
        }
    }

    /// Deletes the extension's copy of the file.
    func discard() {
        if case let .file(file)? = content {
            file.discard()
        }
    }

    private func save(_ file: StagedShareFile, using client: AlfredClient) async throws -> FileRef {
        if let uploaded { return uploaded }
        let saved = try await client.upload(fileAt: file.url, name: file.name, contentType: file.contentType) { [weak self] fraction in
            Task { @MainActor in self?.noteProgress(fraction) }
        }
        uploaded = saved
        return saved
    }

    /// Moves the progress forward, never back: reports come from another thread and may be late.
    private func noteProgress(_ fraction: Double) {
        guard case let .sending(known) = phase, fraction > (known ?? 0) else { return }
        phase = .sending(fraction)
    }

    /// The text of a page's message: the note, then the title and the address.
    static func pageText(url: URL, title: String?, note: String) -> String {
        var lines: [String] = []
        if let title = title?.trimmingCharacters(in: .whitespacesAndNewlines), !title.isEmpty {
            let characters = Array(title)
            lines.append(characters.count > titleLimit ? String(characters.prefix(titleLimit)) + "…" : title)
        }
        lines.append(url.absoluteString)
        let page = lines.joined(separator: "\n")
        return note.isEmpty ? page : note + "\n\n" + page
    }

    /// What the owner reads when a send fails.
    static func message(for error: any Error) -> String {
        switch error {
        case let error as ShareError: error.message
        case AlfredError.unauthorized: "这台设备已被撤销，请在 Alfred 里重新配对"
        case AlfredError.forbidden: "Cloudflare Access 拒绝了请求"
        case let AlfredError.http(status, message): message ?? "服务器返回了意外的状态 \(status)"
        case let error as URLError: "无法连接服务器：\(error.localizedDescription)"
        default: "发送失败：\(error.localizedDescription)"
        }
    }
}
