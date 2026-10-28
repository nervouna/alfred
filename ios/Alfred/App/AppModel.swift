import AlfredKit
import Foundation
import Observation

/// The app's tabs. The model owns the one on screen so a notification can open the chat.
enum AppTab: Hashable {
    case chat
    case tasks
    case documents
    case ideas
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

    /// A scheduled task's run that is running, as the banner above the composer shows it: the task's title (the run's
    /// when the app does not know the task) and the latest step.
    struct TaskRunBanner: Identifiable, Hashable {
        let runId: String
        let title: String
        let stepText: String?

        var id: String { runId }
    }

    /// A message or a question card the chat should scroll to. `number` is new for each request, so asking for the same
    /// row twice scrolls twice.
    struct RevealRequest: Hashable {
        let itemId: String
        let number: Int
    }

    /// A task the 任务 tab should show. `number` is new for each request, so asking for the same task twice opens it twice.
    struct TaskOpenRequest: Hashable {
        let taskId: String
        let number: Int
    }

    /// Opens the event stream of a client from an event id. The app opens an `EventStream`; tests open streams they script.
    typealias StreamOpener = @Sendable (AlfredClient, Int64) async -> AsyncStream<EventStreamUpdate>

    /// The device's credentials; `nil` until it is paired.
    private(set) var credentials: Credentials?
    private(set) var timeline = Timeline()
    /// The owner's tasks: the list read from the server, kept current by `task.updated` events.
    private(set) var taskCatalog = TaskCatalog()
    /// Why the last read of the task list failed, until a read works.
    private(set) var taskFailure: String?
    /// The owner's documents: the list read from the server, kept current by `document.updated` events.
    private(set) var documentCatalog = DocumentCatalog()
    /// Why the last read of the document list failed, until a read works.
    private(set) var documentFailure: String?
    /// Alfred's ideas: the list read from the server, kept current by `idea.updated` events.
    private(set) var ideaCatalog = IdeaCatalog()
    /// Why the last read of the idea list failed, until a read works.
    private(set) var ideaFailure: String?
    /// The root ALFRED.md as the server last gave it: read by `refreshRules`, replaced by a save of the owner's.
    private(set) var rules: Rules?
    /// How many reads of the rules are out.
    private var rulesReads = 0
    /// The ideas the owner has seen, kept on the phone.
    let seenIdeas: SeenIdeas
    /// The comments on documents that the owner wrote and has not submitted. They are kept on the phone.
    let annotationDrafts: DraftStore
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
    var selectedTab = AppTab.chat {
        didSet { noteIdeasSeen() }
    }
    /// What the owner has typed in the chat's composer and not sent. 讨论 adds an idea to it.
    var composerText = ""
    /// The task whose detail the 任务 tab should open. It stays until the tab has opened it (`taskOpenHandled`).
    private(set) var taskOpenRequest: TaskOpenRequest?
    /// Where the chat should scroll to. It stays until the chat has seen the row on screen (`revealHandled`).
    private(set) var revealRequest: RevealRequest?

    /// The read of the idea list that follows a generation's end, while it runs, and whether another end came meanwhile.
    @ObservationIgnored private var ideaRefreshAfterGeneration: Task<Void, Never>?
    @ObservationIgnored private var ideaRefreshAgain = false

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
    @ObservationIgnored private var taskOpenCount = 0
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
        draftFile: DraftFile? = nil,
        seenIdeas: SeenIdeas = SeenIdeas(),
        makeClientId: @escaping () -> String = { "c-" + UUID().uuidString.lowercased() },
        openStream: @escaping StreamOpener = AppModel.openEventStream
    ) {
        self.store = store
        annotationDrafts = DraftStore(file: draftFile)
        self.seenIdeas = seenIdeas
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
        AppModel(
            store: AppKeychain.store(),
            push: LivePushSystem(),
            pushEnvironment: PushToken.environment(),
            draftFile: .standard,
            seenIdeas: SeenIdeas(defaults: .standard)
        )
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
        taskCatalog = TaskCatalog()
        taskFailure = nil
        documentCatalog = DocumentCatalog()
        documentFailure = nil
        ideaCatalog = IdeaCatalog()
        ideaFailure = nil
        ideaRefreshAgain = false
        rules = nil
        seenIdeas.clear()
        composerText = ""
        taskOpenRequest = nil
        annotationDrafts.clear()
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
        noteIdeasSeen()
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
            // The stream is up, or up again: whatever changed while it was down is in the list.
            Task { await refreshTasks() }
            Task { await refreshIdeas() }
        case let .received(event):
            apply(event)
            noteIdeasSeen()
            forgetClosedQuestions()
        case let .backlog(events):
            // One pass with no suspension, so the views see the list go from what it was to the whole backlog in one
            // update, not grow by an event at a time.
            for event in events { apply(event) }
            noteIdeasSeen()
            forgetClosedQuestions()
        case .disconnected:
            isConnected = false
        case let .stopped(error):
            isConnected = false
            streamFailure = error
        }
    }

    /// What one stream event changes. The work that only needs doing once per update is left to `handle`.
    private func apply(_ event: StreamEvent) {
        timeline.apply(event)
        taskCatalog.apply(event)
        documentCatalog.apply(event)
        ideaCatalog.apply(event)
        // How a generation went is in the list, not in its run: read it again now that the run has ended.
        if IdeaCatalog.endsGeneration(event) { refreshIdeasAfterGeneration() }
        trackItem(of: event)
        if case let .event(stored) = event, case let .messageCreated(message) = stored.payload, let clientId = message.clientId {
            failedClientIds.remove(clientId)
            if let sent = outgoingAttachments.removeValue(forKey: clientId) {
                AttachmentStaging.discard(sent)
            }
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

    // MARK: Tasks

    /// Reads the task list (`GET /api/tasks`) and merges it with what events have told. The tab asks for it when it appears
    /// and on pull to refresh, and the stream asks each time it connects. A failure is kept in `taskFailure`.
    func refreshTasks() async {
        guard let client, let credentials else { return }
        do {
            let list = try await client.tasks()
            // The pairing may have changed while the request was out.
            guard self.credentials == credentials else { return }
            taskCatalog.load(list)
            taskFailure = nil
        } catch where LoadFailure.isCancellation(error) {
            return
        } catch {
            guard self.credentials == credentials else { return }
            taskFailure = LoadFailure.message(for: error)
        }
    }

    /// Creates a task, and lists it at once, ahead of its `task.updated` event. A refusal is thrown, for the form to show.
    func createTask(_ draft: TaskDraft) async throws {
        try await perform({ try await $0.createTask(draft) }, then: { taskCatalog.apply($0) })
    }

    /// Changes a task: the form's fields, or its status to pause, resume or end it. The result is listed at once.
    func updateTask(id: String, changes: TaskChanges) async throws {
        try await perform({ try await $0.updateTask(id: id, changes: changes) }, then: { taskCatalog.apply($0) })
    }

    /// Queues a run of the task now. Its next scheduled time stays as it was, and the run arrives as a `run.updated` event.
    func runTask(id: String) async throws {
        try await perform({ try await $0.runTask(id: id) }, then: { _ in })
    }

    /// The title to show above a message a task's run delivered, when the app knows the task.
    func taskLabel(for message: Message) -> String? {
        taskCatalog.label(for: message)
    }

    /// Makes a call that changes a task and passes a refusal on, for the screen that asked to show. An access error also
    /// reaches the stream's screen, as it does for the owner's messages. `apply` takes the result, unless the app was
    /// paired again meanwhile.
    @discardableResult
    private func perform<T: Sendable>(_ call: (AlfredClient) async throws -> T, then apply: (T) -> Void) async throws -> T {
        guard let client, let credentials else { throw URLError(.userAuthenticationRequired) }
        do {
            let result = try await call(client)
            if self.credentials == credentials {
                apply(result)
            }
            return result
        } catch {
            if self.credentials == credentials {
                noteAccess(error)
            }
            throw error
        }
    }

    /// Makes the 任务 tab open a task's detail: the tab is shown, and opens it once it has appeared.
    func openTask(id: String) {
        taskOpenCount += 1
        taskOpenRequest = TaskOpenRequest(taskId: id, number: taskOpenCount)
        selectedTab = .tasks
    }

    /// The tab has opened a request's task (or given up on it): the request is done. A newer request stays.
    func taskOpenHandled(_ request: TaskOpenRequest) {
        if taskOpenRequest == request {
            taskOpenRequest = nil
        }
    }

    // MARK: Ideas

    /// Reads the idea list (`GET /api/ideas`) and merges it with what events have told. The stream asks for it each time
    /// it connects, and the tab asks on pull to refresh. A failure is kept in `ideaFailure`. Once a list is read, the
    /// seen ideas are pruned to the ones the catalog holds.
    func refreshIdeas() async {
        guard let client, let credentials else { return }
        do {
            let list = try await client.ideas()
            // The pairing may have changed while the request was out.
            guard self.credentials == credentials else { return }
            ideaCatalog.load(list)
            ideaFailure = nil
            seenIdeas.prune(keeping: ideaCatalog.ids)
            noteIdeasSeen()
        } catch where LoadFailure.isCancellation(error) {
            return
        } catch {
            guard self.credentials == credentials else { return }
            ideaFailure = LoadFailure.message(for: error)
        }
    }

    /// Reads the idea list again because a generation's run ended, which is when its outcome (`lastGeneration`) is
    /// there. Ends that arrive while a read is out, as a replay of the event log brings many, are covered by one more
    /// read after it, not one each.
    private func refreshIdeasAfterGeneration() {
        guard ideaRefreshAfterGeneration == nil else {
            ideaRefreshAgain = true
            return
        }
        ideaRefreshAfterGeneration = Task {
            repeat {
                ideaRefreshAgain = false
                await refreshIdeas()
            } while ideaRefreshAgain
            ideaRefreshAfterGeneration = nil
        }
    }

    /// The open ideas the owner has not seen: the 想法 tab's badge.
    var unseenIdeaCount: Int {
        ideaCatalog.open.filter { !seenIdeas.contains($0.id) }.count
    }

    /// Whether the 想法 tab is what the owner is looking at: the app is active and paired, and the tab is selected.
    private var isIdeasVisible: Bool {
        isForeground && isPaired && streamFailure == nil && selectedTab == .ideas
    }

    /// Every open idea is seen while the tab is on screen, the ones that arrive meanwhile included.
    private func noteIdeasSeen() {
        guard isIdeasVisible else { return }
        seenIdeas.markSeen(ideaCatalog.open.map(\.id))
    }

    /// Accepts an idea as the task the owner confirmed in the form. The idea and its task are listed at once. A refusal is
    /// thrown, for the form to show.
    @discardableResult
    func acceptIdea(_ idea: AlfredIdea, as acceptance: IdeaAcceptance) async throws -> AlfredTask {
        let accepted = try await perform({
            try await $0.acceptIdea(
                ideaId: idea.id,
                title: acceptance.title,
                brief: acceptance.brief,
                schedule: acceptance.schedule,
                model: acceptance.model,
                budgetUsd: acceptance.budgetUsd
            )
        }, then: { accepted in
            ideaCatalog.apply(accepted.idea)
            taskCatalog.apply(accepted.task)
        })
        return accepted.task
    }

    /// Turns an idea down with a reason and a note, if the owner wrote one. The idea moves to history at once. A refusal
    /// is thrown.
    func rejectIdea(id: String, reason: RejectionReason, note: String?) async throws {
        let note = note.flatMap(IdeaPresentation.note(from:))
        try await perform({ try await $0.rejectIdea(ideaId: id, reason: reason, note: note) }, then: { ideaCatalog.apply($0) })
    }

    /// Asks Alfred to think of ideas now. The generation shows as under way at once; its run follows in the events. A
    /// refusal is thrown.
    func generateIdeas() async throws {
        try await perform({ try await $0.generateIdeas() }, then: { ideaCatalog.noteGeneration(runId: $0) })
    }

    /// 讨论: shows the chat with the idea's title and brief in the composer, after whatever the owner had typed there.
    /// Nothing is sent.
    func discuss(_ idea: AlfredIdea) {
        composerText = IdeaPresentation.discussion(of: idea, after: composerText)
        selectedTab = .chat
    }

    // MARK: Documents

    /// Reads the document list (`GET /api/documents`) and merges it with what events have told. The tab asks for it when
    /// it appears and on pull to refresh. A failure is kept in `documentFailure`.
    func refreshDocuments() async {
        guard let client, let credentials else { return }
        do {
            let list = try await client.documents()
            // The pairing may have changed while the request was out.
            guard self.credentials == credentials else { return }
            documentCatalog.load(list)
            documentFailure = nil
        } catch where LoadFailure.isCancellation(error) {
            return
        } catch {
            guard self.credentials == credentials else { return }
            documentFailure = LoadFailure.message(for: error)
        }
    }

    // MARK: Rules

    /// Whether a read of the rules is out.
    var isLoadingRules: Bool {
        rulesReads > 0
    }

    /// Reads ALFRED.md (`GET /api/rules`) and keeps it. The profile page asks for it when it appears and on pull to
    /// refresh, and 载入新内容 asks after a conflict. A failure is shown in the usual alert and leaves what was kept. The
    /// rules read are handed back, `nil` when the read did not work.
    @discardableResult
    func refreshRules() async -> Rules? {
        guard let client, let credentials else { return nil }
        rulesReads += 1
        defer { rulesReads -= 1 }
        do {
            let read = try await client.rules()
            // The pairing may have changed while the request was out.
            guard self.credentials == credentials else { return nil }
            rules = read
            return read
        } catch where LoadFailure.isCancellation(error) {
            return nil
        } catch {
            guard self.credentials == credentials else { return nil }
            noteAccess(error)
            actionFailure = LoadFailure.message(for: error)
            return nil
        }
    }

    /// Replaces ALFRED.md with `text`, against the `version` the owner edited. The rules the server answers with are kept at
    /// once. A 409, a version that is not the file's current one, is `.conflict` and shows nothing: the editor asks the
    /// owner what to do. Any other refusal or failure shows in the usual alert, with the server's message when it gave one.
    func saveRules(text: String, version: String) async -> RulesSaving {
        do {
            let saved = try await perform({ try await $0.saveRules(text: text, version: version) }, then: { rules = $0 })
            return .saved(saved)
        } catch AlfredError.http(status: 409, message: _) {
            return .conflict
        } catch {
            actionFailure = LoadFailure.commandMessage(for: error)
            return .failed
        }
    }

    // MARK: Annotations

    /// Sends the document's drafts as one revision of `version`, its current version, whose text is `text` (`nil` for a
    /// document with no text to anchor on). The batch is the whole-document comments and the passages that fit `text`, in the
    /// order they were written; a draft that does not fit stays. On 202 the drafts that went are removed and the annotations
    /// Alfred recorded show as submitted at once. On 409 the document's detail is read again and handed back, and the
    /// drafts stay; on any other refusal, and on a network error, they stay too.
    func submitAnnotations(documentId: String, version: String, text: AnchorText?) async -> AnnotationSubmission {
        let batch = annotationDrafts.list.batch(documentId: documentId, in: text)
        guard !batch.isEmpty else { return .nothingToSend }
        guard let client, let credentials else { return .failed(message: LoadFailure.unpaired) }
        do {
            let accepted = try await client.revise(
                documentId: documentId,
                version: version,
                annotations: batch.map { AnnotationDraft(target: $0.target, comment: $0.comment) }
            )
            // The pairing may have changed while the request was out.
            if self.credentials == credentials {
                annotationDrafts.remove(ids: Set(batch.map(\.id)))
                for annotation in accepted.annotations {
                    documentCatalog.apply(annotation)
                }
            }
            return .accepted(runId: accepted.runId, annotations: accepted.annotations)
        } catch AlfredError.http(status: 409, message: let message) {
            let detail = try? await client.document(id: documentId)
            if let detail, self.credentials == credentials {
                documentCatalog.apply(detail.document)
            }
            return .conflict(message: message ?? "文档已经有了新的版本，请核对后再提交", detail: detail)
        } catch {
            if self.credentials == credentials {
                noteAccess(error)
            }
            if case AlfredError.http = error {
                return .rejected(message: LoadFailure.commandMessage(for: error))
            }
            return .failed(message: LoadFailure.message(for: error))
        }
    }

    /// Makes a draft from an annotation that went back, written on the document's `current` version: a passage is
    /// anchored on `text`, the current version's text, when it is known and the passage fits it. Otherwise the draft keeps
    /// the context and the version of the annotation, and is anchored when the current version is shown (and lands in
    /// 已失配 until then, and after, if it does not fit).
    @discardableResult
    func reedit(_ annotation: Annotation, current: String, text: AnchorText?) -> StoredDraft {
        let draft = annotationDrafts.add(
            documentId: annotation.documentId,
            version: annotation.version,
            target: annotation.target,
            comment: annotation.comment,
            origin: annotation.id
        )
        annotationDrafts.reanchor(documentId: annotation.documentId, to: current, in: text)
        return annotationDrafts.list.draft(id: draft.id) ?? draft
    }

    /// Undoes the revision `runId` made of a document: the document comes back as a new version, which is listed at once.
    /// A refusal is returned with the server's own words.
    func undoRevision(documentId: String, runId: String) async -> UndoOutcome {
        do {
            let document = try await perform({ try await $0.undoRevision(documentId: documentId, runId: runId) }, then: { documentCatalog.apply($0) })
            return .undone(document)
        } catch {
            return .refused(LoadFailure.commandMessage(for: error))
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

    /// The newest chat run that is running: the one the stop button stops. A chat run is a run of kind `task` without a
    /// `taskId`. A scheduled task's run is not the chat's; `taskRunBanners` shows it.
    var runningChatRun: Run? {
        timeline.runs.values
            .filter { $0.kind == .task && $0.taskId == nil && $0.status == .running }
            .max { $0.startedAt < $1.startedAt }
    }

    /// The scheduled task runs that are running, oldest first, for the banner above the composer.
    var taskRunBanners: [TaskRunBanner] {
        timeline.runs.values
            .filter { $0.kind == .task && $0.taskId != nil && $0.status == .running }
            .sorted { ($0.startedAt, $0.id) < ($1.startedAt, $1.id) }
            .map { run in
                let title = run.taskId.flatMap { taskCatalog.task(id: $0)?.title } ?? run.title
                return TaskRunBanner(runId: run.id, title: title, stepText: stepText(of: run.id))
            }
    }

    /// The replies being written and the steps being taken, oldest run first. A run shows when it has a draft, or
    /// when it is a running chat run with a step. A scheduled task's run never shows here: the banner does.
    var liveReplies: [LiveReply] {
        let runIds = Set(timeline.drafts.keys).union(
            timeline.runs.values.filter { $0.kind == .task && $0.status == .running }.map(\.id)
        )
        return runIds
            .filter { timeline.runs[$0]?.taskId == nil }
            .compactMap { runId -> (Date, LiveReply)? in
                let draft = timeline.drafts[runId].map(\.text).flatMap { $0.isEmpty ? nil : $0 }
                let step = stepText(of: runId)
                guard draft != nil || step != nil else { return nil }
                let started = timeline.runs[runId]?.startedAt ?? .distantPast
                return (started, LiveReply(runId: runId, text: draft, stepText: step))
            }
            .sorted { ($0.0, $0.1.runId) < ($1.0, $1.1.runId) }
            .map(\.1)
    }

    /// A run's latest step as the chat shows it: `WebFetch：https://…`.
    private func stepText(of runId: String) -> String? {
        timeline.latestStep[runId].map { "\($0.tool)：\($0.detail)" }
    }
}
