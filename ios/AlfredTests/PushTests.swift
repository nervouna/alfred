import AlfredKit
import UserNotifications
import XCTest

@testable import Alfred

/// Records what the app asks of the system for notifications, in order.
@MainActor
final class FakePushSystem: PushSystem {
    enum Call: Equatable {
        case requestAuthorization
        case register
        case unregister
    }

    private(set) var calls: [Call] = []
    /// What the owner has allowed, as the system answers when asked. Asking is not a call in `calls`.
    var allowed: NotificationAuthorization = .notDetermined
    /// How many times the app opened the system's notification settings.
    private(set) var openedSettings = 0

    func authorization() async -> NotificationAuthorization {
        allowed
    }

    func openNotificationSettings() {
        openedSettings += 1
    }

    func requestAuthorization() {
        calls.append(.requestAuthorization)
    }

    func registerForRemoteNotifications() {
        calls.append(.register)
    }

    func unregisterForRemoteNotifications() {
        calls.append(.unregister)
    }
}

@MainActor
final class PushTests: XCTestCase {
    /// A model on a fake server with a fake notification system. `replies` scripts `/api/push`; the event stream
    /// delivers `frames`.
    private func makeBed(
        paired: Bool = true,
        environment: PushEnvironment? = .development,
        push replies: [StubReply] = [StubReply(status: 204)],
        frames: [Data] = []
    ) throws -> (model: AppModel, server: StubServer, system: FakePushSystem) {
        let pushScript = ReplyScript(replies)
        let server = StubServer { request in
            switch request.url?.path ?? "" {
            case "/api/ping": return StubReply(status: 204)
            case "/api/push": return pushScript.next()
            case "/api/events": return .stream(frames)
            default: return StubReply(status: 404)
            }
        }
        let system = FakePushSystem()
        let model = AppModel(
            store: InMemoryCredentialStore(paired ? try server.credentials() : nil),
            session: server.session,
            push: system,
            pushEnvironment: environment
        )
        // The server unregisters its handler when it goes, so it stays until the test is over.
        addTeardownBlock { @MainActor in
            model.background()
            withExtendedLifetime(server) {}
        }
        return (model, server, system)
    }

    private let token = Data([0x00, 0xAB, 0xFF, 0x0A, 0x10, 0x7F, 0x80, 0x01])

    // MARK: The token

    func testTheTokenBecomesLowercaseHex() {
        XCTAssertEqual(PushToken.hex(token), "00abff0a107f8001")
        XCTAssertEqual(PushToken.hex(Data()), "")
        let long = Data((0..<32).map { UInt8(255 - $0) })
        let hex = PushToken.hex(long)
        XCTAssertEqual(hex.count, 64)
        XCTAssertEqual(hex, hex.lowercased())
        XCTAssertEqual(hex.prefix(8), "fffefdfc")
    }

    func testTheEnvironmentComesFromInfoPlist() {
        XCTAssertEqual(PushToken.environment(infoValue: "development"), .development)
        XCTAssertEqual(PushToken.environment(infoValue: "production"), .production)
        XCTAssertNil(PushToken.environment(infoValue: nil))
        XCTAssertNil(PushToken.environment(infoValue: ""))
        XCTAssertNil(PushToken.environment(infoValue: "sandbox"))
        XCTAssertNil(PushToken.environment(infoValue: 3))
    }

    func testTheBuiltAppIsSetToRegisterWithTheDevelopmentGateway() {
        let value = Bundle.main.object(forInfoDictionaryKey: "AlfredAPNsEnvironment")
        XCTAssertEqual(value as? String, "development", "Info.plist has no AlfredAPNsEnvironment")
        XCTAssertEqual(PushToken.environment(infoValue: value), .development)
    }

    func testTheRegistrationBodyCarriesTheTokenAndTheEnvironment() async throws {
        let (model, server, _) = try makeBed()

        await model.registerPushToken(token)

        let request = try XCTUnwrap(server.requests(to: "/api/push").first)
        XCTAssertEqual(request.request.httpMethod, "POST")
        XCTAssertEqual(request.command, ["token": "00abff0a107f8001", "environment": "development"])
        XCTAssertEqual(request.request.value(forHTTPHeaderField: "Authorization"), "Bearer EXAMPLE-DEVICE-TOKEN-NOT-REAL-0123456789abc")
        XCTAssertEqual(request.request.value(forHTTPHeaderField: "CF-Access-Client-Id"), "example-service-token.access")
        XCTAssertNil(model.streamFailure)
    }

    func testAProductionBuildRegistersForProduction() async throws {
        let (model, server, _) = try makeBed(environment: .production)
        await model.registerPushToken(token)
        XCTAssertEqual(server.requests(to: "/api/push").first?.command?["environment"], "production")
    }

    func testABuildWithoutAnEnvironmentRegistersNothing() async throws {
        let (model, server, _) = try makeBed(environment: nil)
        await model.registerPushToken(token)
        XCTAssertTrue(server.requests(to: "/api/push").isEmpty)
    }

    // MARK: Registering again

    func testTheTokenIsRegisteredAgainWhenItChanges() async throws {
        let (model, server, _) = try makeBed()

        await model.registerPushToken(token)
        await model.registerPushToken(token)
        XCTAssertEqual(server.requests(to: "/api/push").count, 1, "the same token is not sent twice")

        await model.registerPushToken(Data([0x01, 0x02]))
        let sent = server.requests(to: "/api/push")
        XCTAssertEqual(sent.map { $0.command?["token"] }, ["00abff0a107f8001", "0102"])
    }

    func testAFailedRegistrationIsSentAgainWithTheSameToken() async throws {
        let (model, server, _) = try makeBed(push: [StubReply(status: 500), StubReply(status: 204)])

        await model.registerPushToken(token)
        XCTAssertNil(model.streamFailure, "a server error is not an access error")
        XCTAssertNil(model.actionFailure, "and the owner is not told")

        // The next launch brings the same token again.
        await model.registerPushToken(token)
        XCTAssertEqual(server.requests(to: "/api/push").count, 2)
        await model.registerPushToken(token)
        XCTAssertEqual(server.requests(to: "/api/push").count, 2, "a registration that went through is not repeated")
    }

    func testANetworkErrorIsRetriedOnTheNextLaunchToo() async throws {
        let (model, server, _) = try makeBed(push: [StubReply(failure: .notConnectedToInternet), StubReply(status: 204)])
        await model.registerPushToken(token)
        XCTAssertNil(model.streamFailure)
        await model.registerPushToken(token)
        XCTAssertEqual(server.requests(to: "/api/push").count, 2)
    }

    func testARevokedDeviceLeavesItToThePairingFlow() async throws {
        let (model, _, _) = try makeBed(push: [StubReply(status: 401)])
        await model.registerPushToken(token)
        XCTAssertEqual(model.streamFailure, .unauthorized)
        XCTAssertTrue(model.isPaired, "the credentials stay until the owner pairs again")
    }

    func testRefusedAccessLeavesItToTheAccessFlow() async throws {
        let (model, _, _) = try makeBed(push: [StubReply(status: 403)])
        await model.registerPushToken(token)
        XCTAssertEqual(model.streamFailure, .forbidden)
    }

    func testATokenThatArrivesBeforePairingIsRegisteredOncePaired() async throws {
        let (model, server, _) = try makeBed(paired: false)

        await model.registerPushToken(token)
        XCTAssertTrue(server.requests(to: "/api/push").isEmpty, "there are no credentials to register with")

        await model.pair(with: server.pairingJSON)
        XCTAssertEqual(server.requests(to: "/api/push").count, 1)
        XCTAssertEqual(server.requests(to: "/api/push").first?.command?["token"], "00abff0a107f8001")
    }

    func testPairingAgainRegistersTheTokenForTheNewDevice() async throws {
        let (model, server, _) = try makeBed()
        await model.registerPushToken(token)
        model.unpair()
        // The system hands the token over again after the next register call, and the new pairing sends it.
        await model.pair(with: server.pairingJSON)
        await model.registerPushToken(token)
        XCTAssertEqual(server.requests(to: "/api/push").count, 2)
    }

    // MARK: Permission and remote notifications

    func testAPairedLaunchAsksForPermissionAndRegisters() throws {
        let (model, _, system) = try makeBed()
        model.startPush()
        XCTAssertEqual(system.calls, [.requestAuthorization, .register])
    }

    func testAnUnpairedLaunchAsksForNothing() throws {
        let (model, _, system) = try makeBed(paired: false)
        model.startPush()
        XCTAssertEqual(system.calls, [])
    }

    func testPairingAsksForPermissionAndRegisters() async throws {
        let (model, server, system) = try makeBed(paired: false)
        await model.pair(with: server.pairingJSON)
        XCTAssertEqual(system.calls, [.requestAuthorization, .register])
    }

    func testAFailedPairingAsksForNothing() async throws {
        let server = StubServer { _ in StubReply(status: 401) }
        let system = FakePushSystem()
        let model = AppModel(store: InMemoryCredentialStore(), session: server.session, push: system, pushEnvironment: .development)
        await model.pair(with: server.pairingJSON)
        XCTAssertEqual(system.calls, [])
    }

    func testUnpairingUnregistersFromRemoteNotifications() throws {
        let (model, _, system) = try makeBed()
        model.unpair()
        XCTAssertEqual(system.calls, [.unregister])
        XCTAssertFalse(model.isPaired)
    }

    // MARK: In the foreground

    func testNothingIsShownWhileTheChatIsVisible() {
        XCTAssertEqual(NotificationPresentation.options(chatVisible: true), [])
    }

    func testABannerWithSoundIsShownOtherwise() {
        XCTAssertEqual(NotificationPresentation.options(chatVisible: false), [.banner, .sound])
    }

    func testTheChatIsVisibleOnlyOnItsTabInAnActiveApp() throws {
        let (model, _, _) = try makeBed()
        XCTAssertFalse(model.isChatVisible, "the app is not active yet")

        model.foreground()
        XCTAssertTrue(model.isChatVisible)
        XCTAssertEqual(NotificationPresentation.options(chatVisible: model.isChatVisible), [])

        model.selectedTab = .tasks
        XCTAssertFalse(model.isChatVisible)
        XCTAssertEqual(NotificationPresentation.options(chatVisible: model.isChatVisible), [.banner, .sound])

        model.selectedTab = .documents
        XCTAssertFalse(model.isChatVisible)

        model.selectedTab = .chat
        XCTAssertTrue(model.isChatVisible)

        model.background()
        XCTAssertFalse(model.isChatVisible)
    }

    func testTheChatIsNotVisibleOnThePairingScreen() throws {
        let (model, _, _) = try makeBed(paired: false)
        model.foreground()
        XCTAssertFalse(model.isChatVisible)
    }

    func testTheChatIsNotVisibleBehindAnAccessError() async throws {
        let (model, _, _) = try makeBed(push: [StubReply(status: 401)])
        model.foreground()
        await model.registerPushToken(token)
        XCTAssertEqual(model.streamFailure, .unauthorized)
        XCTAssertFalse(model.isChatVisible)
    }

    // MARK: The payload

    /// A payload shaped like the one the workbench sends.
    private func userInfo(_ json: String) throws -> [AnyHashable: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [AnyHashable: Any])
    }

    func testTheEventIdAndTheRunIdAreReadFromThePayload() throws {
        let target = NotificationTarget(userInfo: try userInfo("""
        {"aps":{"alert":{"title":"Alfred","body":"报告写好了"},"sound":"default","thread-id":"chat"},"eventId":4217,"runId":"k7m2qa"}
        """))
        XCTAssertEqual(target.eventId, 4217)
        XCTAssertEqual(target.runId, "k7m2qa")
    }

    func testAPayloadWithoutARunHasOnlyTheEventId() throws {
        let target = NotificationTarget(userInfo: try userInfo("""
        {"aps":{"alert":{"title":"Alfred","body":"在吗"},"sound":"default","thread-id":"chat"},"eventId":9}
        """))
        XCTAssertEqual(target.eventId, 9)
        XCTAssertNil(target.runId)
    }

    func testAPayloadWithoutOurKeysOpensNothingInParticular() throws {
        let target = NotificationTarget(userInfo: try userInfo(#"{"aps":{"alert":"hi"}}"#))
        XCTAssertNil(target.eventId)
        XCTAssertNil(target.runId)
    }

    func testKeysOfTheWrongTypeAreIgnored() throws {
        for json in [
            #"{"eventId":"abc","runId":7}"#,
            #"{"eventId":-3}"#,
            #"{"eventId":1.5}"#,
            #"{"eventId":true}"#,
            #"{"eventId":null,"runId":null}"#,
            #"{"runId":""}"#,
        ] {
            let target = NotificationTarget(userInfo: try userInfo(json))
            XCTAssertNil(target.eventId, json)
            XCTAssertNil(target.runId, json)
        }
    }

    func testAnEventIdThatCameAsTextIsRead() throws {
        XCTAssertEqual(NotificationTarget(userInfo: try userInfo(#"{"eventId":"12"}"#)).eventId, 12)
    }

    // MARK: Opening the chat from a notification

    func testATapOpensTheChatAndScrollsToTheMessage() async throws {
        let frames = [
            messageFrame(id: 3, text: "第一条"),
            messageFrame(id: 4, text: "第二条"),
            messageFrame(id: 5, text: "第三条"),
        ]
        let (model, _, _) = try makeBed(frames: frames)
        model.selectedTab = .tasks
        model.foreground()
        await eventually { model.timeline.lastEventId == 5 }

        model.openChat(for: NotificationTarget(eventId: 4, runId: nil))

        XCTAssertEqual(model.selectedTab, .chat)
        let request = try XCTUnwrap(model.revealRequest)
        XCTAssertEqual(request.itemId, "m-m4")
        XCTAssertEqual(model.timeline.items.map(\.id), ["m-m3", "m-m4", "m-m5"])
    }

    func testATapOnAQuestionScrollsToItsCard() async throws {
        let frames = [
            messageFrame(id: 1, text: "开始"),
            questionAskedFrame(id: 2, questionId: "q42", questions: [("红还是蓝？", ["红", "蓝"], false)]),
            messageFrame(id: 3, text: "后面"),
        ]
        let (model, _, _) = try makeBed(frames: frames)
        model.foreground()
        await eventually { model.timeline.lastEventId == 3 }

        model.openChat(for: NotificationTarget(eventId: 2, runId: "cccccc"))

        XCTAssertEqual(model.revealRequest?.itemId, "q-q42")
    }

    func testATapOnAnEventTheTimelineLacksJustOpensTheChat() async throws {
        let (model, _, _) = try makeBed(frames: [messageFrame(id: 1, text: "第一条")])
        model.selectedTab = .documents
        model.foreground()
        await eventually { model.timeline.lastEventId == 1 }

        model.openChat(for: NotificationTarget(eventId: 99, runId: nil))

        XCTAssertEqual(model.selectedTab, .chat)
        XCTAssertNil(model.revealRequest)
    }

    func testATapWithoutAnEventIdJustOpensTheChat() throws {
        let (model, _, _) = try makeBed()
        model.selectedTab = .tasks
        model.openChat(for: NotificationTarget(eventId: nil, runId: nil))
        XCTAssertEqual(model.selectedTab, .chat)
        XCTAssertNil(model.revealRequest)
    }

    func testAHandledRequestIsCleared() async throws {
        let (model, _, _) = try makeBed(frames: [messageFrame(id: 1, text: "第一条")])
        model.foreground()
        await eventually { model.timeline.lastEventId == 1 }
        model.openChat(for: NotificationTarget(eventId: 1, runId: nil))
        let request = try XCTUnwrap(model.revealRequest)

        model.revealHandled(request)
        XCTAssertNil(model.revealRequest)

        // A newer request is not cleared by the old one's answer.
        model.openChat(for: NotificationTarget(eventId: 1, runId: nil))
        let newer = try XCTUnwrap(model.revealRequest)
        model.revealHandled(request)
        XCTAssertEqual(model.revealRequest, newer)
    }

    func testUnpairingForgetsWhereTheEventsWere() async throws {
        let (model, _, _) = try makeBed(frames: [messageFrame(id: 1, text: "第一条")])
        model.foreground()
        await eventually { model.timeline.lastEventId == 1 }
        model.unpair()

        model.openChat(for: NotificationTarget(eventId: 1, runId: nil))
        XCTAssertNil(model.revealRequest)
    }
}
