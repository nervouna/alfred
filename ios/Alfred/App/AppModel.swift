import AlfredKit
import Foundation
import Observation

/// The app's tabs. The model owns the one on screen so a notification can open the chat.
enum AppTab: Hashable {
    case chat
    case runs
    case documents
}

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

    /// A message or a question card the chat should scroll to. `number` is new for each request, so asking for the same
    /// row twice scrolls twice.
    struct RevealRequest: Hashable {
        let itemId: String
        let number: Int
    }

    /// Opens the event stream of a client from an event id. The app opens an `EventStream`; tests open streams they script.
    typealias StreamOpener = @Sendable (AlfredClient, Int64) async -> AsyncStream<EventStreamUpdate>

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
    /// The files chosen for the next message, in the order they were chosen.
    private(set) var draftAttachments: [Attachment] = []
    /// The files of the owner's pending messages by client id, each with how far its upload is. A message's entry goes
    /// when its echo arrives.
    private(set) var outgoingAttachments: [String: [Attachment]] = [:]
    /// The questions with an answer on its way, until they close.
    private(set) var answeringQuestions: Set<String> = []
    /// Why the last answer to a question failed, by question id. The question stays open.
    private(set) var answerFailures: [String: String] = [:]
    /// How many calls to `attach` are bringing files in.
    private var stagingCount = 0
    /// The tab on screen.
    var selectedTab = AppTab.chat
    /// Where the chat should scroll to. It stays until the chat has seen the row on screen (`revealHandled`).
    private(set) var revealRequest: RevealRequest?

    @ObservationIgnored private let store: any CredentialStore
    @ObservationIgnored private let session: URLSession
    @ObservationIgnored private let makeClientId: () -> String
    @ObservationIgnored private let openStream: StreamOpener
    @ObservationIgnored private let push: any PushSystem
    /// The APNs environment this build registers with; `nil` registers nothing.
    @ObservationIgnored private let pushEnvironment: PushEnvironment?
    /// The APNs device token the system last handed over.
    @ObservationIgnored private var pushToken: Data?
    /// The registration Alfred accepted for these credentials, so the same token is not sent again.
    @ObservationIgnored private var registeredPush: PushRegistration?
    /// The timeline row of each stored message and question, by the id of the event that created it. A notification
    /// names an event.
    @ObservationIgnored private var itemIdsByEvent: [Int64: String] = [:]
    @ObservationIgnored private var revealCount = 0
    /// Whether the scene is in the foreground. The stream runs only then.
    @ObservationIgnored private var isForeground = false
    @ObservationIgnored private var streamTask: Task<Void, Never>?
    /// Counts the streams started, so a stream that ended can tell it is not the current one.
    @ObservationIgnored private var streamGeneration = 0

    init(
        store: any CredentialStore,
        session: URLSession = .shared,
        push: any PushSystem = NoPushSystem(),
        pushEnvironment: PushEnvironment? = nil,
        makeClientId: @escaping () -> String = { "c-" + UUID().uuidString.lowercased() },
        openStream: @escaping StreamOpener = AppModel.openEventStream
    ) {
        self.store = store
        self.session = session
        self.push = push
        self.pushEnvironment = pushEnvironment
        self.makeClientId = makeClientId
        self.openStream = openStream
        credentials = try? store.load()
    }

    /// The model the app runs on: credentials from the keychain, requests on the shared session, notifications from
    /// the system, registered for the APNs environment the build was signed for.
    static func live() -> AppModel {
        AppModel(store: AppKeychain.store(), push: LivePushSystem(), pushEnvironment: PushToken.environment())
    }

    nonisolated static func openEventStream(_ client: AlfredClient, after lastEventId: Int64) async -> AsyncStream<EventStreamUpdate> {
        await EventStream(client: client, after: lastEventId).updates()
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
        startPush()
        await registerPushIfPossible()
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
        push.unregisterForRemoteNotifications()
        pushToken = nil
    }

    private func reset() {
        timeline = Timeline()
        failedClientIds = []
        AttachmentStaging.discard(draftAttachments + outgoingAttachments.values.flatMap { $0 })
        draftAttachments = []
        outgoingAttachments = [:]
        answeringQuestions = []
        answerFailures = [:]
        streamFailure = nil
        isConnected = false
        registeredPush = nil
        itemIdsByEvent = [:]
        revealRequest = nil
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

    /// Tries again after Cloudflare Access refused the stream. A stream task still held is stopped first, so the retry
    /// always starts a fresh stream, from the last event the timeline has.
    func retryStream() {
        stopStream()
        streamFailure = nil
        startStreamIfNeeded()
    }

    private func startStreamIfNeeded() {
        guard isForeground, streamTask == nil, streamFailure == nil, let client else { return }
        let after = timeline.lastEventId
        let open = openStream
        streamGeneration += 1
        let generation = streamGeneration
        streamTask = Task { [weak self] in
            for await update in await open(client, after) {
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
            trackItem(of: event)
            if case let .event(stored) = event, case let .messageCreated(message) = stored.payload, let clientId = message.clientId {
                failedClientIds.remove(clientId)
                if let sent = outgoingAttachments.removeValue(forKey: clientId) {
                    AttachmentStaging.discard(sent)
                }
            }
            forgetClosedQuestions()
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

    // MARK: Push

    /// Asks the owner for permission to notify (alert, sound, badge) and the system for an APNs token. It runs when the
    /// app starts paired and when a pairing succeeds; the system asks the owner only once. The token arrives in
    /// `registerPushToken`.
    func startPush() {
        guard isPaired else { return }
        push.requestAuthorization()
        push.registerForRemoteNotifications()
    }

    /// The system handed over the APNs token, at launch or because it changed: register it with Alfred. A token that
    /// came before the pairing is registered once the app is paired. A 401 or 403 is an access error, and the pairing
    /// flow shows it; any other failure leaves the token unregistered, and the next launch sends it again.
    func registerPushToken(_ token: Data) async {
        pushToken = token
        await registerPushIfPossible()
    }

    private func registerPushIfPossible() async {
        guard let client, let credentials, let pushToken, let pushEnvironment else { return }
        let registration = PushRegistration(token: PushToken.hex(pushToken), environment: pushEnvironment)
        guard registration != registeredPush else { return }
        do {
            try await client.registerPush(registration)
            // The pairing may have changed while the request was out.
            if self.credentials == credentials {
                registeredPush = registration
            }
        } catch {
            if self.credentials == credentials {
                noteAccess(error)
            }
        }
    }

    /// Whether the chat is what the owner is looking at: the app is active, paired and showing the chat tab. A
    /// notification that arrives then is not shown, because the chat already has the message.
    var isChatVisible: Bool {
        isForeground && isPaired && streamFailure == nil && selectedTab == .chat
    }

    /// The owner tapped a notification: show the chat, scrolled to the message or question it was about when the
    /// timeline has it.
    func openChat(for target: NotificationTarget) {
        selectedTab = .chat
        guard let eventId = target.eventId, let itemId = itemIdsByEvent[eventId] else { return }
        revealCount += 1
        revealRequest = RevealRequest(itemId: itemId, number: revealCount)
    }

    /// The chat has shown a request's row (or given up on it): the request is done. A newer request stays.
    func revealHandled(_ request: RevealRequest) {
        if revealRequest == request {
            revealRequest = nil
        }
    }

    private func trackItem(of event: StreamEvent) {
        guard case let .event(stored) = event else { return }
        switch stored.payload {
        case let .messageCreated(message):
            itemIdsByEvent[stored.id] = TimelineItem.message(message).id
        case let .questionAsked(asked):
            if let record = timeline.questions.first(where: { $0.id == asked.id }) {
                itemIdsByEvent[stored.id] = TimelineItem.question(record).id
            }
        default:
            break
        }
    }

    // MARK: Sending

    /// Sends the owner's message with the files chosen for it, and clears them from the draft.
    func sendDraft(_ text: String) async {
        let attachments = draftAttachments
        draftAttachments = []
        await send(text, attachments: attachments)
    }

    /// Sends the owner's message: it shows as pending at once, and stays pending until its echo arrives. Its files
    /// are uploaded first, in order; the message goes out once every one is saved. The text may be empty with files.
    func send(_ text: String, attachments: [Attachment] = []) async {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty || !attachments.isEmpty else { return }
        let clientId = makeClientId()
        timeline.addPending(clientId: clientId, text: text)
        if !attachments.isEmpty {
            outgoingAttachments[clientId] = attachments
        }
        await deliver(clientId: clientId, text: text)
    }

    /// Sends a failed message again with the same client id, so a message that did arrive is not stored twice. Files
    /// that were saved are not uploaded again.
    func retry(clientId: String) async {
        guard failedClientIds.contains(clientId), let pending = timeline.pending.first(where: { $0.clientId == clientId }) else { return }
        failedClientIds.remove(clientId)
        await deliver(clientId: clientId, text: pending.text)
    }

    private func deliver(clientId: String, text: String) async {
        do {
            guard let client else { throw URLError(.userAuthenticationRequired) }
            let files = try await upload(filesOf: clientId, using: client)
            try await client.send(.messageSend(clientId: clientId, text: text, files: files))
        } catch {
            // The echo may have come first, with the response lost on the way back.
            if timeline.pending.contains(where: { $0.clientId == clientId }) {
                failedClientIds.insert(clientId)
            }
            noteAccess(error)
        }
    }

    /// Uploads the files of a pending message that are not saved yet, one after the other in the order they were
    /// chosen, and returns every file's inbox path in that order. A file that fails is marked and the rest still go
    /// up; then this throws, so the message is not sent.
    private func upload(filesOf clientId: String, using client: AlfredClient) async throws -> [FileRef] {
        var failure: (any Error)?
        for index in 0..<(outgoingAttachments[clientId]?.count ?? 0) {
            // The echo came, or the pairing went: the message is no longer ours to send.
            guard let attachment = outgoingAttachments[clientId]?[index] else { throw CancellationError() }
            if case .uploaded = attachment.state { continue }
            setState(.uploading(0), ofAttachment: attachment.id, in: clientId)
            do {
                let file = try await client.upload(
                    fileAt: attachment.fileURL,
                    name: attachment.name,
                    contentType: attachment.contentType
                ) { [weak self] fraction in
                    Task { @MainActor in self?.noteProgress(fraction, ofAttachment: attachment.id, in: clientId) }
                }
                setState(.uploaded(file), ofAttachment: attachment.id, in: clientId)
            } catch {
                setState(.failed, ofAttachment: attachment.id, in: clientId)
                failure = failure ?? error
                noteAccess(error)
            }
        }
        if let failure { throw failure }
        return (outgoingAttachments[clientId] ?? []).compactMap { attachment in
            if case let .uploaded(file) = attachment.state { file } else { nil }
        }
    }

    private func setState(_ state: Attachment.State, ofAttachment id: UUID, in clientId: String) {
        guard let index = outgoingAttachments[clientId]?.firstIndex(where: { $0.id == id }) else { return }
        outgoingAttachments[clientId]?[index].state = state
    }

    /// Moves a progress bar forward, never back: reports come from another thread and may be late.
    private func noteProgress(_ fraction: Double, ofAttachment id: UUID, in clientId: String) {
        guard case let .uploading(known)? = outgoingAttachments[clientId]?.first(where: { $0.id == id })?.state, fraction > known else { return }
        setState(.uploading(fraction), ofAttachment: id, in: clientId)
    }

    // MARK: Attachments

    /// Whether files are being brought in right now.
    var isStaging: Bool {
        stagingCount > 0
    }

    /// Adds files to the draft. Each is copied, so the original may go away, and a photo Claude cannot read becomes a
    /// JPEG. A file that is too large, or that would be the eleventh, is refused by name in `actionFailure`; the
    /// others are still added.
    func attach(_ inputs: [AttachmentInput]) async {
        guard !inputs.isEmpty else { return }
        stagingCount += 1
        defer { stagingCount -= 1 }
        var refusals: [AttachmentRefusal] = []
        for input in inputs {
            guard draftAttachments.count < AttachmentLimits.maxCount else {
                refusals.append(.tooMany(name: input.name))
                AttachmentStaging.discard(input)
                continue
            }
            do {
                let staged = try await Task.detached { try AttachmentStaging.stage(input) }.value
                // Another call may have filled the draft meanwhile.
                if draftAttachments.count < AttachmentLimits.maxCount {
                    draftAttachments.append(staged)
                } else {
                    AttachmentStaging.discard([staged])
                    refusals.append(.tooMany(name: input.name))
                }
            } catch let refusal as AttachmentRefusal {
                refusals.append(refusal)
            } catch {
                refusals.append(.unreadable(name: input.name))
            }
        }
        if !refusals.isEmpty {
            actionFailure = refusals.map(\.message).joined(separator: "\n")
        }
    }

    /// Takes a file out of the draft.
    func removeAttachment(id: Attachment.ID) {
        guard let index = draftAttachments.firstIndex(where: { $0.id == id }) else { return }
        AttachmentStaging.discard([draftAttachments.remove(at: index)])
    }

    // MARK: Questions

    /// Answers a question that is one single-select question with the option the owner tapped.
    func answer(_ asked: QuestionAsked, choosing label: String) async {
        guard asked.questions.count == 1, let question = asked.questions.first, !question.multiSelect,
              question.options.contains(where: { $0.label == label })
        else { return }
        await submitAnswers([question.question: label], to: asked.id)
    }

    /// Answers a question with what the owner picked on its card, once every question has a pick.
    func answer(_ asked: QuestionAsked, selection: QuestionSelection) async {
        guard let answers = selection.answers(for: asked.questions) else { return }
        await submitAnswers(answers, to: asked.id)
    }

    private func submitAnswers(_ answers: [String: String], to questionId: String) async {
        guard !answeringQuestions.contains(questionId) else { return }
        answeringQuestions.insert(questionId)
        answerFailures[questionId] = nil
        do {
            guard let client else { throw URLError(.userAuthenticationRequired) }
            try await client.send(.questionAnswer(questionId: questionId, answers: answers))
            // The card stays disabled until the question.answered event arrives, which may have come already.
            forgetClosedQuestions()
        } catch {
            answeringQuestions.remove(questionId)
            answerFailures[questionId] = Self.answerFailure(of: error)
            noteAccess(error)
        }
    }

    /// A question that closed needs neither its answer on its way nor an error.
    private func forgetClosedQuestions() {
        guard !answeringQuestions.isEmpty || !answerFailures.isEmpty else { return }
        let closed = Set(timeline.questions.filter { $0.state != .open }.map(\.id))
        answeringQuestions.subtract(closed)
        answerFailures = answerFailures.filter { !closed.contains($0.key) }
    }

    private static func answerFailure(of error: any Error) -> String {
        if case AlfredError.http(404, _) = error { return "这个问题已不在等待回答" }
        return "回答失败，请重试"
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
