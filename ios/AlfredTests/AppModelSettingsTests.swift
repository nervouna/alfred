import AlfredKit
import Synchronization
import XCTest

@testable import Alfred

/// Counts calls from any thread: the number of calls before this one.
private final class CallCounter: Sendable {
    private let count = Mutex(0)

    func next() -> Int {
        count.withLock { value in
            defer { value += 1 }
            return value
        }
    }
}

/// The app's settings: kept current by `settings.updated` events, loaded from `GET /api/settings`, changed by
/// `settings.update`, and the notification state it shows next to them.
@MainActor
final class AppModelSettingsTests: XCTestCase {
    /// A paired model on a fake server whose event stream is scripted: `updates` arrive in order, and the stream stays
    /// open. `detail` answers `GET /api/settings` in turn, `commands` answers `POST /api/commands`. The wait that makes
    /// taps on a stepper one command is short, so the tests do not wait for half a second.
    private func makeModel(
        updates: [EventStreamUpdate] = [],
        detail: [StubReply]? = nil,
        commands: [StubReply]? = nil,
        coalescing: Duration = .milliseconds(40),
        firstCommandTakes delay: TimeInterval = 0,
        push: FakePushSystem = FakePushSystem()
    ) throws -> (AppModel, StubServer) {
        let commandsSeen = CallCounter()
        let detailScript = ReplyScript(try detail ?? [StubReply(chunks: [TestData.settingsDetailData(spentTodayUsd: 1.25)])])
        let commandScript = ReplyScript(try commands ?? [StubReply(chunks: [TestData.settingsResultData()])])
        let server = StubServer { request in
            switch request.url?.path ?? "" {
            case "/api/settings": return detailScript.next()
            case "/api/commands":
                // A call that is slow to answer is out while the test changes something else.
                if commandsSeen.next() == 0, delay > 0 { Thread.sleep(forTimeInterval: delay) }
                return commandScript.next()
            case "/api/tasks": return StubReply(chunks: [(try? TestData.taskList([])) ?? Data()])
            case "/api/ideas": return StubReply(chunks: [(try? TestData.ideaList([])) ?? Data()])
            default: return StubReply(status: 404)
            }
        }
        let model = AppModel(
            store: InMemoryCredentialStore(try server.credentials()),
            session: server.session,
            push: push,
            settingsCoalescing: coalescing,
            openStream: { _, _ in AsyncStream { continuation in updates.forEach { continuation.yield($0) } } }
        )
        addTeardownBlock { @MainActor in
            model.background()
            // A stepper's wait that is still running ends with the pairing.
            model.unpair()
            withExtendedLifetime(server) {}
        }
        return (model, server)
    }

    private func result(_ settings: [String: Any]) throws -> StubReply {
        StubReply(chunks: [try TestData.settingsResultData(settings)])
    }

    private func refusal(_ message: String, status: Int = 400) -> StubReply {
        StubReply(status: status, chunks: [Data(#"{"error":"\#(message)"}"#.utf8)])
    }

    private func event(_ id: Int, _ settings: [String: Any]) throws -> EventStreamUpdate {
        .received(try TestData.streamEvent(TestData.settingsEvent(id, settings: settings)))
    }

    private func commands(_ server: StubServer) -> [[String: Any]] {
        server.requests(to: "/api/commands").compactMap(\.chatCommand)
    }

    // MARK: Events

    func testASettingsEventUpdatesTheCatalog() async throws {
        let (model, _) = try makeModel(updates: [
            try event(1, TestData.settingsObject(dailyBudgetUsd: 30, overridden: ["dailyBudgetUsd"])),
            try event(2, TestData.settingsObject(model: "opus", dailyBudgetUsd: 30, overridden: ["model", "dailyBudgetUsd"])),
        ])
        model.foreground()

        await eventually { model.settingsCatalog.model == .opus }
        XCTAssertEqual(model.settingsCatalog.dailyBudgetUsd, 30)
        XCTAssertEqual(model.settingsCatalog.overridden, [SettingKey.model, SettingKey.dailyBudgetUsd])
        XCTAssertEqual(model.timeline.lastEventId, 2, "the timeline still moves its resume point past settings events")
    }

    func testAnOlderEventDoesNotUndoANewerOne() async throws {
        let (model, _) = try makeModel(updates: [
            try event(5, TestData.settingsObject(model: "opus")),
            try event(4, TestData.settingsObject(model: "haiku")),
        ])
        model.foreground()

        await eventually { model.timeline.lastEventId >= 5 }
        await eventually { model.settingsCatalog.model != nil }
        XCTAssertEqual(model.settingsCatalog.model, .opus)
    }

    // MARK: Loading

    func testLoadingFillsTheCatalogAndKeepsTodaysSpend() async throws {
        let (model, server) = try makeModel(detail: [StubReply(chunks: [try TestData.settingsDetailData(TestData.settingsObject(model: "haiku", overridden: ["model"]), spentTodayUsd: 0.75)])])

        await model.refreshSettings()

        XCTAssertEqual(model.settingsCatalog.model, .haiku)
        XCTAssertEqual(model.settingsCatalog.spentTodayUsd, 0.75)
        XCTAssertNil(model.settingsFailure)
        XCTAssertEqual(server.requests(to: "/api/settings").count, 1)
        XCTAssertEqual(server.requests(to: "/api/settings").first?.request.httpMethod, "GET")
    }

    func testAFailedLoadSaysWhyWithoutAnAlertAndKeepsTheSettings() async throws {
        let (model, _) = try makeModel(detail: [
            StubReply(chunks: [try TestData.settingsDetailData()]),
            refusal("bad gateway", status: 502),
            StubReply(chunks: [try TestData.settingsDetailData()]),
        ])
        await model.refreshSettings()
        XCTAssertNotNil(model.settingsCatalog.settings)

        await model.refreshSettings()
        XCTAssertEqual(model.settingsFailure, "服务器返回 502：bad gateway")
        XCTAssertNil(model.actionFailure)
        XCTAssertNotNil(model.settingsCatalog.settings)

        await model.refreshSettings()
        XCTAssertNil(model.settingsFailure)
    }

    func testAReadThatBeganAfterAnEventIsNewerThanIt() async throws {
        let (model, _) = try makeModel(
            updates: [try event(1, TestData.settingsObject(model: "opus"))],
            detail: [StubReply(chunks: [try TestData.settingsDetailData(TestData.settingsObject(model: "haiku"), spentTodayUsd: 2)])]
        )
        model.foreground()
        await eventually { model.settingsCatalog.model == .opus }

        await model.refreshSettings()
        XCTAssertEqual(model.settingsCatalog.spentTodayUsd, 2)
        XCTAssertEqual(model.settingsCatalog.model, .haiku, "a read that began after the event is the newer one")
    }

    // MARK: Saving

    func testAChangeIsSentAsOneCommandAndTheAnswerReplacesTheSettings() async throws {
        let (model, server) = try makeModel(commands: [try result(TestData.settingsObject(model: "opus", overridden: ["model"]))])
        await model.refreshSettings()

        await model.updateSettings(SettingsChanges(model: .opus))

        let sent = try XCTUnwrap(commands(server).first)
        XCTAssertEqual(commands(server).count, 1)
        XCTAssertEqual(sent["type"] as? String, "settings.update")
        XCTAssertEqual(sent["model"] as? String, "opus")
        XCTAssertEqual(Set(sent.keys), ["type", "model"], "only the changed setting is sent")
        XCTAssertEqual(model.settingsCatalog.model, .opus)
        XCTAssertEqual(model.settingsCatalog.overridden, [SettingKey.model])
        XCTAssertEqual(model.settingsCatalog.spentTodayUsd, 1.25, "the spend is not in the answer, and stays")
        XCTAssertNil(model.actionFailure)
    }

    func testTheNewValueIsShownBeforeTheAnswerComes() async throws {
        let (model, _) = try makeModel()
        await model.refreshSettings()

        model.adjustSettings(SettingsChanges(dailyBudgetUsd: 25))

        XCTAssertEqual(model.settingsCatalog.dailyBudgetUsd, 25, "shown at once, before anything is sent")
        XCTAssertEqual(model.settingsCatalog.settings?.dailyBudgetUsd, 20)
    }

    func testAFailedSaveRestoresTheValueAndSaysWhy() async throws {
        let (model, server) = try makeModel(commands: [refusal("dailyBudgetUsd 超出范围")])
        await model.refreshSettings()

        await model.updateSettings(SettingsChanges(dailyBudgetUsd: 25))

        XCTAssertEqual(commands(server).count, 1)
        XCTAssertEqual(model.settingsCatalog.dailyBudgetUsd, 20, "the value goes back to what the catalog held")
        XCTAssertEqual(model.actionFailure, "设置没有保存：dailyBudgetUsd 超出范围")
    }

    func testAFailedSaveOverANetworkErrorSaysSo() async throws {
        let (model, _) = try makeModel(commands: [StubReply(failure: .notConnectedToInternet)])
        await model.refreshSettings()

        await model.updateSettings(SettingsChanges(model: .opus))

        XCTAssertEqual(model.settingsCatalog.model, .sonnet)
        XCTAssertTrue(try XCTUnwrap(model.actionFailure).hasPrefix("设置没有保存："))
    }

    func testTapsOnAStepperMakeOneCommandWithTheLastValue() async throws {
        let (model, server) = try makeModel(commands: [try result(TestData.settingsObject(dailyBudgetUsd: 35, overridden: ["dailyBudgetUsd"]))])
        await model.refreshSettings()

        model.adjustSettings(SettingsChanges(dailyBudgetUsd: 25))
        model.adjustSettings(SettingsChanges(dailyBudgetUsd: 30))
        model.adjustSettings(SettingsChanges(dailyBudgetUsd: 35))
        XCTAssertEqual(model.settingsCatalog.dailyBudgetUsd, 35)
        XCTAssertTrue(commands(server).isEmpty, "nothing is sent while the taps go on")

        await eventually { !commands(server).isEmpty }
        await eventually { model.settingsCatalog.settings?.dailyBudgetUsd == 35 }
        // A second command would have gone out by now.
        try await Task.sleep(for: .milliseconds(150))
        XCTAssertEqual(commands(server).count, 1)
        XCTAssertEqual(commands(server).first?["dailyBudgetUsd"] as? Double, 35)
        XCTAssertNil(model.actionFailure)
    }

    func testTapsOnDifferentSettingsGoInTheSameCommand() async throws {
        let (model, server) = try makeModel()
        await model.refreshSettings()

        model.adjustSettings(SettingsChanges(dailyBudgetUsd: 25))
        model.adjustSettings(SettingsChanges(runBudgetUsd: 5))
        await eventually { !commands(server).isEmpty }

        let sent = try XCTUnwrap(commands(server).first)
        XCTAssertEqual(sent["dailyBudgetUsd"] as? Double, 25)
        XCTAssertEqual(sent["runBudgetUsd"] as? Double, 5)
    }

    func testAChoiceMadeWhileTapsAreWaitingSendsThemAllAtOnce() async throws {
        let (model, server) = try makeModel(coalescing: .seconds(60))
        await model.refreshSettings()

        model.adjustSettings(SettingsChanges(dailyBudgetUsd: 25))
        await model.updateSettings(SettingsChanges(model: .opus))

        XCTAssertEqual(commands(server).count, 1, "the choice does not wait, and takes the taps with it")
        let sent = try XCTUnwrap(commands(server).first)
        XCTAssertEqual(sent["dailyBudgetUsd"] as? Double, 25)
        XCTAssertEqual(sent["model"] as? String, "opus")
    }

    func testAChangeMadeWhileACallIsOutFollowsItAfterTheAnswer() async throws {
        let (model, server) = try makeModel(
            commands: [
                try result(TestData.settingsObject(dailyBudgetUsd: 25, overridden: ["dailyBudgetUsd"])),
                try result(TestData.settingsObject(model: "opus", dailyBudgetUsd: 25, overridden: ["model", "dailyBudgetUsd"])),
            ],
            firstCommandTakes: 0.3
        )
        await model.refreshSettings()

        let first = Task { await model.updateSettings(SettingsChanges(dailyBudgetUsd: 25)) }
        await eventually { !commands(server).isEmpty }
        XCTAssertEqual(commands(server).count, 1)
        await model.updateSettings(SettingsChanges(model: .opus))
        await first.value

        let sent = commands(server)
        XCTAssertEqual(sent.count, 2, "one call is out at a time, and the change that came meanwhile follows it")
        XCTAssertEqual(sent.first?["dailyBudgetUsd"] as? Double, 25)
        XCTAssertNil(sent.first?["model"])
        XCTAssertEqual(sent.last?["model"] as? String, "opus")
        XCTAssertNil(sent.last?["dailyBudgetUsd"], "a change that went is not sent again")
        XCTAssertEqual(model.settingsCatalog.model, .opus)
        XCTAssertEqual(model.settingsCatalog.dailyBudgetUsd, 25)
    }

    func testTurningTheIdeaTimeOffSendsNull() async throws {
        let (model, server) = try makeModel(
            detail: [StubReply(chunks: [try TestData.settingsDetailData(TestData.settingsObject(ideasAt: "08:00"))])],
            commands: [try result(TestData.settingsObject(ideasAt: nil, overridden: ["ideasAt"]))]
        )
        await model.refreshSettings()
        XCTAssertEqual(model.settingsCatalog.ideasAt, TimeOfDay(hour: 8, minute: 0))

        await model.updateSettings(SettingsChanges(ideasAt: .off))

        let sent = try XCTUnwrap(commands(server).first)
        XCTAssertTrue(sent["ideasAt"] is NSNull, "off is an explicit null")
        XCTAssertNil(model.settingsCatalog.ideasAt)
    }

    func testResettingAllSendsTheEightKeysAndNothingElse() async throws {
        let (model, server) = try makeModel(
            detail: [StubReply(chunks: [try TestData.settingsDetailData(TestData.settingsObject(model: "haiku", dailyBudgetUsd: 30, overridden: ["model", "dailyBudgetUsd"]))])],
            commands: [try result(TestData.settingsObject())]
        )
        await model.refreshSettings()
        XCTAssertTrue(model.settingsCatalog.canResetAll)

        await model.updateSettings(SettingsChanges(reset: SettingsPresentation.keys))

        let sent = try XCTUnwrap(commands(server).first)
        XCTAssertEqual(Set(sent.keys), ["type", "reset"])
        XCTAssertEqual(sent["reset"] as? [String], ["model", "dailyBudgetUsd", "runBudgetUsd", "sessionIdleHours", "compactTokens", "memoryScanMinutes", "memoryScanBudgetUsd", "ideasAt"])
        XCTAssertEqual(model.settingsCatalog.model, .sonnet)
        XCTAssertEqual(model.settingsCatalog.dailyBudgetUsd, 20)
        XCTAssertFalse(model.settingsCatalog.canResetAll)
    }

    // MARK: Unpairing

    func testUnpairingClearsWhatTheCatalogHeld() async throws {
        let (model, _) = try makeModel()
        await model.refreshSettings()
        model.adjustSettings(SettingsChanges(dailyBudgetUsd: 25))
        XCTAssertNotNil(model.settingsCatalog.settings)

        model.unpair()

        XCTAssertNil(model.settingsCatalog.settings)
        XCTAssertNil(model.settingsCatalog.spentTodayUsd)
        XCTAssertNil(model.settingsCatalog.dailyBudgetUsd, "a change that was waiting is gone too")
        XCTAssertNil(model.settingsFailure)
    }

    func testAChangeThatWasWaitingIsNotSentAfterUnpairing() async throws {
        let (model, server) = try makeModel()
        await model.refreshSettings()
        model.adjustSettings(SettingsChanges(dailyBudgetUsd: 25))

        model.unpair()
        try await Task.sleep(for: .milliseconds(150))

        XCTAssertTrue(commands(server).isEmpty)
        XCTAssertNil(model.actionFailure)
    }

    // MARK: Notifications

    func testTheNotificationStateComesFromTheSystem() async throws {
        let system = FakePushSystem()
        let (model, _) = try makeModel(push: system)
        XCTAssertNil(model.notificationAuthorization, "nothing is known before the system is asked")

        system.allowed = .denied
        await model.refreshNotificationState()
        XCTAssertEqual(model.notificationAuthorization, .denied)

        system.allowed = .allowed
        await model.refreshNotificationState()
        XCTAssertEqual(model.notificationAuthorization, .allowed)
    }

    func testTheNotificationStateIsReadAgainWhenTheAppReturnsToTheForeground() async throws {
        let system = FakePushSystem()
        system.allowed = .notDetermined
        let (model, _) = try makeModel(push: system)
        model.foreground()
        await eventually { model.notificationAuthorization == .notDetermined }

        // The owner turned notifications on in the system's settings and came back.
        system.allowed = .allowed
        model.background()
        model.foreground()
        await eventually { model.notificationAuthorization == .allowed }
    }

    func testAskingForTheStateIsNotAskingForPermission() async throws {
        let system = FakePushSystem()
        let (model, _) = try makeModel(push: system)
        model.foreground()
        await model.refreshNotificationState()
        XCTAssertEqual(system.calls, [], "only startPush asks, and registers")
    }

    func testTheButtonOpensTheSystemsNotificationSettings() throws {
        let system = FakePushSystem()
        let (model, _) = try makeModel(push: system)
        model.openNotificationSettings()
        XCTAssertEqual(system.openedSettings, 1)
    }
}
