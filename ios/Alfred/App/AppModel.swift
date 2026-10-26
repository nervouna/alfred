import AlfredKit
import Foundation
import Observation

/// What the app knows and does: whether it is paired, the stream of events from Alfred and the timeline they
/// build, and the owner's sends. Views read it and call it; they hold no state of their own beyond what they edit.
@MainActor
@Observable
final class AppModel {
    /// Why a pairing attempt did not pair.
    enum PairingFailure: Hashable {
        /// The code is not a pairing this app can read.
        case invalidCode
        /// 401: the server does not accept the device token.
        case deviceRefused
        /// 403: Cloudflare Access refused the service token.
        case accessRefused
        case server(status: Int)
        case network(String)
        /// The keychain would not take the credentials.
        case storage

        /// The text the pairing screen shows.
        var message: String {
            switch self {
            case .invalidCode: "这不是有效的配对信息"
            case .deviceRefused: "服务器拒绝了这台设备，请重新生成配对信息"
            case .accessRefused: "Cloudflare Access 拒绝了请求"
            case let .server(status): "服务器返回了意外的状态 \(status)"
            case let .network(reason): "无法连接服务器：\(reason)"
            case .storage: "无法把配对信息存入钥匙串"
            }
        }
    }

    /// What the chat shows below the messages for a run: the reply as it is written, and the step the run is on.
    struct LiveReply: Identifiable, Hashable {
        let runId: String
        let text: String?
        let stepText: String?

        var id: String { runId }
    }

    /// The device's credentials; `nil` until it is paired.
    private(set) var credentials: Credentials?
    private(set) var timeline = Timeline()
    /// Whether the event stream is connected right now.
    private(set) var isConnected = false
    /// The access error that stopped the stream, until the owner pairs again or retries.
    private(set) var streamFailure: AlfredError?
    private(set) var pairingFailure: PairingFailure?
    private(set) var isPairing = false
    /// The client ids of pending messages whose send failed.
    private(set) var failedClientIds: Set<String> = []
    /// A failure to show once, for an action the owner took.
    var actionFailure: String?

    @ObservationIgnored private let store: any CredentialStore
    @ObservationIgnored private let session: URLSession
    @ObservationIgnored private let makeClientId: () -> String
    /// Whether the scene is in the foreground. The stream runs only then.
    @ObservationIgnored private var isForeground = false
    @ObservationIgnored private var streamTask: Task<Void, Never>?
    /// Counts the streams started, so a stream that ended can tell it is not the current one.
    @ObservationIgnored private var streamGeneration = 0

    init(
        store: any CredentialStore,
        session: URLSession = .shared,
        makeClientId: @escaping () -> String = { "c-" + UUID().uuidString.lowercased() }
    ) {
        self.store = store
        self.session = session
        self.makeClientId = makeClientId
        credentials = try? store.load()
    }

    /// The model the app runs on: credentials from the keychain, requests on the shared session.
    static func live() -> AppModel {
        AppModel(store: AppKeychain.store())
    }

    var isPaired: Bool {
        credentials != nil
    }

    var client: AlfredClient? {
        credentials.map { AlfredClient(credentials: $0, session: session) }
    }

    // MARK: Pairing

    /// Pairs from what a QR code or the pasteboard held: the pairing JSON, alone or after other text such as the
    /// `[pairing]` label `app-dev` prints. The credentials are saved only once the server accepts them.
    func pair(with payload: String) async {
        guard !isPairing else { return }
        isPairing = true
        pairingFailure = nil
        defer { isPairing = false }

        guard let pairing = Self.pairing(in: payload) else {
            pairingFailure = .invalidCode
            return
        }
        let candidate = Credentials(pairing: pairing)
        do {
            try await AlfredClient(credentials: candidate, session: session).ping()
        } catch {
            pairingFailure = Self.failure(of: error)
            return
        }
        do {
            try store.save(candidate)
        } catch {
            pairingFailure = .storage
            return
        }
        stopStream()
        reset()
        credentials = candidate
        startStreamIfNeeded()
    }

    /// Forgets the pairing: deletes the credentials and the timeline, and returns to the pairing screen.
    func unpair() {
        do {
            try store.delete()
        } catch {
            actionFailure = "无法清除钥匙串中的配对信息"
            return
        }
        stopStream()
        reset()
        credentials = nil
        pairingFailure = nil
    }

    private func reset() {
        timeline = Timeline()
        failedClientIds = []
        streamFailure = nil
        isConnected = false
    }

    private static func pairing(in text: String) -> Pairing? {
        guard let open = text.firstIndex(of: "{"), let close = text.lastIndex(of: "}"), open < close else { return nil }
        return try? JSONDecoder().decode(Pairing.self, from: Data(text[open...close].utf8))
    }

    private static func failure(of error: any Error) -> PairingFailure {
        switch error {
        case AlfredError.unauthorized: .deviceRefused
        case AlfredError.forbidden: .accessRefused
        case let AlfredError.http(status, _): .server(status: status)
        default: .network(error.localizedDescription)
        }
    }

    // MARK: The event stream

    /// The scene is active: follow the stream from the last event the timeline has.
    func foreground() {
        isForeground = true
        startStreamIfNeeded()
    }

    /// The scene went to the background: drop the stream. The timeline keeps its place for the next `foreground`.
    func background() {
        isForeground = false
        stopStream()
    }

    /// Tries again after Cloudflare Access refused the stream.
    func retryStream() {
        streamFailure = nil
        startStreamIfNeeded()
    }

    private func startStreamIfNeeded() {
        guard isForeground, streamTask == nil, streamFailure == nil, let client else { return }
        let stream = EventStream(client: client, after: timeline.lastEventId)
        streamGeneration += 1
        let generation = streamGeneration
        streamTask = Task { [weak self] in
            for await update in await stream.updates() {
                guard let self, !Task.isCancelled else { return }
                self.handle(update)
            }
            self?.streamEnded(generation)
        }
    }

    private func stopStream() {
        streamTask?.cancel()
        streamTask = nil
        isConnected = false
    }

    private func streamEnded(_ generation: Int) {
        guard generation == streamGeneration else { return }
        streamTask = nil
        isConnected = false
    }

    private func handle(_ update: EventStreamUpdate) {
        switch update {
        case .connected:
            isConnected = true
        case let .received(event):
            timeline.apply(event)
            if case let .event(stored) = event, case let .messageCreated(message) = stored.payload, let clientId = message.clientId {
                failedClientIds.remove(clientId)
            }
        case .disconnected:
            isConnected = false
        case let .stopped(error):
            isConnected = false
            streamFailure = error
        }
    }

    /// An access error from a command means the stream's failure too: show it instead of a chat that cannot send.
    private func noteAccess(_ error: any Error) {
        guard let error = error as? AlfredError, error == .unauthorized || error == .forbidden else { return }
        streamFailure = error
    }

    // MARK: Sending

    /// Sends the owner's message: it shows as pending at once, and stays pending until its echo arrives.
    func send(_ text: String) async {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        let clientId = makeClientId()
        timeline.addPending(clientId: clientId, text: text)
        await deliver(clientId: clientId, text: text)
    }

    /// Sends a failed message again with the same client id, so a message that did arrive is not stored twice.
    func retry(clientId: String) async {
        guard failedClientIds.contains(clientId), let pending = timeline.pending.first(where: { $0.clientId == clientId }) else { return }
        failedClientIds.remove(clientId)
        await deliver(clientId: clientId, text: pending.text)
    }

    private func deliver(clientId: String, text: String) async {
        do {
            guard let client else { throw URLError(.userAuthenticationRequired) }
            try await client.send(.messageSend(clientId: clientId, text: text, files: []))
        } catch {
            // The echo may have come first, with the response lost on the way back.
            if timeline.pending.contains(where: { $0.clientId == clientId }) {
                failedClientIds.insert(clientId)
            }
            noteAccess(error)
        }
    }

    /// Interrupts a run's current turn.
    func stop(runId: String) async {
        do {
            guard let client else { return }
            try await client.send(.runStop(runId: runId))
        } catch {
            actionFailure = "停止失败"
            noteAccess(error)
        }
    }

    // MARK: What the chat shows

    /// The newest task that is running: the one the stop button stops.
    var runningTask: Run? {
        timeline.runs.values
            .filter { $0.kind == .task && $0.status == .running }
            .max { $0.startedAt < $1.startedAt }
    }

    /// The replies being written and the steps being taken, oldest run first. A run shows when it has a draft, or
    /// when it is a running task with a step.
    var liveReplies: [LiveReply] {
        let runIds = Set(timeline.drafts.keys).union(
            timeline.runs.values.filter { $0.kind == .task && $0.status == .running }.map(\.id)
        )
        return runIds
            .compactMap { runId -> (Date, LiveReply)? in
                let draft = timeline.drafts[runId].map(\.text).flatMap { $0.isEmpty ? nil : $0 }
                let step = timeline.latestStep[runId].map { "\($0.tool)：\($0.detail)" }
                guard draft != nil || step != nil else { return nil }
                let started = timeline.runs[runId]?.startedAt ?? .distantPast
                return (started, LiveReply(runId: runId, text: draft, stepText: step))
            }
            .sorted { ($0.0, $0.1.runId) < ($1.0, $1.1.runId) }
            .map(\.1)
    }
}
