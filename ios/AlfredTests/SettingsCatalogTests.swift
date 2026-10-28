import AlfredKit
import XCTest

@testable import Alfred

final class SettingsCatalogTests: XCTestCase {
    private func loaded(_ settings: [String: Any] = TestData.settingsObject(), spent: Double = 0.42) throws -> SettingsCatalog {
        var catalog = SettingsCatalog()
        catalog.load(try TestData.settingsDetail(settings, spentTodayUsd: spent))
        return catalog
    }

    private func event(_ id: Int, _ settings: [String: Any]) throws -> StreamEvent {
        try TestData.streamEvent(TestData.settingsEvent(id, settings: settings))
    }

    // MARK: Loading

    func testACatalogThatHasReadNothingHasNothing() {
        let catalog = SettingsCatalog()
        XCTAssertNil(catalog.settings)
        XCTAssertNil(catalog.spentTodayUsd)
        XCTAssertNil(catalog.model)
        XCTAssertNil(catalog.dailyBudgetUsd)
        XCTAssertNil(catalog.ideasAt)
        XCTAssertEqual(catalog.overridden, [])
        XCTAssertFalse(catalog.canResetAll)
    }

    func testAReadHoldsTheSettingsAndTodaysSpend() throws {
        let catalog = try loaded(TestData.settingsObject(model: "haiku", dailyBudgetUsd: 30, ideasAt: "07:30", overridden: ["model", "dailyBudgetUsd"]), spent: 1.5)
        XCTAssertEqual(catalog.model, .haiku)
        XCTAssertEqual(catalog.dailyBudgetUsd, 30)
        XCTAssertEqual(catalog.runBudgetUsd, 10)
        XCTAssertEqual(catalog.sessionIdleHours, 4)
        XCTAssertEqual(catalog.compactTokens, 100_000)
        XCTAssertEqual(catalog.memoryScanMinutes, 60)
        XCTAssertEqual(catalog.memoryScanBudgetUsd, 0.1)
        XCTAssertEqual(catalog.ideasAt, TimeOfDay(hour: 7, minute: 30))
        XCTAssertEqual(catalog.spentTodayUsd, 1.5)
    }

    func testAnIdeaTimeThatIsNullIsOff() throws {
        XCTAssertNil(try loaded(TestData.settingsObject(ideasAt: nil)).ideasAt)
    }

    func testAReadReplacesWhatWasHeldAndTakesTheSpendAgain() throws {
        var catalog = try loaded(TestData.settingsObject(dailyBudgetUsd: 30), spent: 1)
        catalog.load(try TestData.settingsDetail(TestData.settingsObject(dailyBudgetUsd: 40), spentTodayUsd: 2))
        XCTAssertEqual(catalog.dailyBudgetUsd, 40)
        XCTAssertEqual(catalog.spentTodayUsd, 2)
    }

    // MARK: settings.updated events

    func testAnEventReplacesTheSettingsAndKeepsTheSpend() throws {
        var catalog = try loaded(spent: 3)
        catalog.apply(try event(7, TestData.settingsObject(model: "opus", overridden: ["model"])))
        XCTAssertEqual(catalog.model, .opus)
        XCTAssertEqual(catalog.overridden, [SettingKey.model])
        XCTAssertEqual(catalog.spentTodayUsd, 3)
    }

    func testAnEventBeforeAnyReadFillsTheSettings() throws {
        var catalog = SettingsCatalog()
        catalog.apply(try event(1, TestData.settingsObject(runBudgetUsd: 5)))
        XCTAssertEqual(catalog.runBudgetUsd, 5)
        XCTAssertNil(catalog.spentTodayUsd, "an event does not say what has been spent")
    }

    func testAnOlderEventIsIgnored() throws {
        var catalog = try loaded()
        catalog.apply(try event(9, TestData.settingsObject(dailyBudgetUsd: 50)))
        catalog.apply(try event(8, TestData.settingsObject(dailyBudgetUsd: 40)))
        XCTAssertEqual(catalog.dailyBudgetUsd, 50, "event 8 is older than event 9")
        catalog.apply(try event(9, TestData.settingsObject(dailyBudgetUsd: 60)))
        XCTAssertEqual(catalog.dailyBudgetUsd, 50, "a replay of event 9 changes nothing")
        catalog.apply(try event(10, TestData.settingsObject(dailyBudgetUsd: 70)))
        XCTAssertEqual(catalog.dailyBudgetUsd, 70)
    }

    func testOtherEventsChangeNothing() throws {
        var catalog = try loaded()
        catalog.apply(try TestData.streamEvent(TestData.taskEvent(12, task: TestData.taskObject("aaaaaa"))))
        XCTAssertEqual(catalog.revision, 0)
        XCTAssertEqual(catalog.dailyBudgetUsd, 20)
    }

    func testAReadThatAnEventOvertookKeepsTheEventsSettingsButTakesTheSpend() throws {
        var catalog = try loaded(spent: 1)
        let began = catalog.revision
        catalog.apply(try event(3, TestData.settingsObject(model: "opus")))
        catalog.load(try TestData.settingsDetail(TestData.settingsObject(model: "haiku"), spentTodayUsd: 2), requestedAt: began)
        XCTAssertEqual(catalog.model, .opus, "the event is newer than the read that began before it")
        XCTAssertEqual(catalog.spentTodayUsd, 2)

        catalog.load(try TestData.settingsDetail(TestData.settingsObject(model: "haiku"), spentTodayUsd: 3), requestedAt: catalog.revision)
        XCTAssertEqual(catalog.model, .haiku, "a read that began after the event is the newer one")
    }

    func testAReplyThatAnEventOvertookIsIgnored() throws {
        var catalog = try loaded()
        let began = catalog.revision
        catalog.apply(try event(3, TestData.settingsObject(dailyBudgetUsd: 25)))
        catalog.confirm(try TestData.settings(TestData.settingsObject(dailyBudgetUsd: 15)), requestedAt: began)
        XCTAssertEqual(catalog.dailyBudgetUsd, 25)

        catalog.confirm(try TestData.settings(TestData.settingsObject(dailyBudgetUsd: 35)), requestedAt: catalog.revision)
        XCTAssertEqual(catalog.dailyBudgetUsd, 35)
    }

    // MARK: overridden

    func testResettingAllIsOfferedOnlyWhileSomethingIsOverridden() throws {
        var catalog = try loaded(TestData.settingsObject(overridden: []))
        XCTAssertFalse(catalog.canResetAll)

        catalog.apply(try event(2, TestData.settingsObject(model: "haiku", overridden: ["model"])))
        XCTAssertTrue(catalog.canResetAll)
        XCTAssertEqual(catalog.overridden, [SettingKey.model])

        catalog.apply(try event(3, TestData.settingsObject(overridden: [])))
        XCTAssertFalse(catalog.canResetAll)
    }

    func testAKeyThisAppDoesNotKnowIsKept() throws {
        let catalog = try loaded(TestData.settingsObject(overridden: ["model", "newerSetting"]))
        XCTAssertEqual(catalog.overridden.map(\.rawValue), ["model", "newerSetting"])
        XCTAssertTrue(catalog.canResetAll)
    }

    // MARK: The tiers of 压缩阈值

    func testTheDefaultSizeIsAmongTheThreeEntries() throws {
        XCTAssertEqual(try loaded(TestData.settingsObject(compactTokens: 100_000)).compactTokensChoices, [100_000, 200_000, 0])
        XCTAssertEqual(try loaded(TestData.settingsObject(compactTokens: 200_000)).compactTokensChoices, [100_000, 200_000, 0])
        XCTAssertEqual(try loaded(TestData.settingsObject(compactTokens: 0)).compactTokensChoices, [100_000, 200_000, 0])
    }

    func testAValueTheDeploymentSetIsOneMoreEntryInOrder() throws {
        XCTAssertEqual(try loaded(TestData.settingsObject(compactTokens: 150_000)).compactTokensChoices, [100_000, 150_000, 200_000, 0])
        XCTAssertEqual(try loaded(TestData.settingsObject(compactTokens: 50_000)).compactTokensChoices, [50_000, 100_000, 200_000, 0])
        XCTAssertEqual(try loaded(TestData.settingsObject(compactTokens: 500_000)).compactTokensChoices, [100_000, 200_000, 500_000, 0])
    }

    func testTheEntriesNeverMisreportTheCurrentValue() throws {
        for tokens in [0, 20_000, 100_000, 123_456, 200_000, 1_000_000] {
            let catalog = try loaded(TestData.settingsObject(compactTokens: tokens))
            XCTAssertTrue(catalog.compactTokensChoices.contains(try XCTUnwrap(catalog.compactTokens)), "\(tokens) is not offered")
        }
    }

    func testTheModelsAreTheThreeAndAnUnknownOneIsAddedToThem() throws {
        XCTAssertEqual(try loaded(TestData.settingsObject(model: "opus")).modelChoices, [.sonnet, .opus, .haiku])
        XCTAssertEqual(try loaded(TestData.settingsObject(model: "mystery")).modelChoices, [.sonnet, .opus, .haiku, TaskModel(rawValue: "mystery")])
    }

    // MARK: Changes the owner has made

    func testAChangeShowsAtOnceAndStaysWhileItIsSent() throws {
        var catalog = try loaded()
        catalog.stage(SettingsChanges(model: .opus, dailyBudgetUsd: 25))
        XCTAssertEqual(catalog.model, .opus)
        XCTAssertEqual(catalog.dailyBudgetUsd, 25)
        XCTAssertEqual(catalog.runBudgetUsd, 10, "a setting without a change shows as it is")
        XCTAssertEqual(catalog.settings?.model, .sonnet, "the settings are still what Alfred said")

        let sent = try XCTUnwrap(catalog.beginSending())
        XCTAssertEqual(sent, SettingsChanges(model: .opus, dailyBudgetUsd: 25))
        XCTAssertEqual(catalog.model, .opus, "still shown while the call is out")
        XCTAssertNil(catalog.beginSending(), "nothing more is staged")
    }

    func testAFailedCallLeavesTheValueAsAlfredHadIt() throws {
        var catalog = try loaded()
        catalog.stage(SettingsChanges(model: .opus))
        _ = catalog.beginSending()
        catalog.finishSending()
        XCTAssertEqual(catalog.model, .sonnet)
    }

    func testAnAnsweredCallShowsTheAnswerAndKeepsTheSpend() throws {
        var catalog = try loaded(spent: 2)
        catalog.stage(SettingsChanges(dailyBudgetUsd: 25))
        _ = catalog.beginSending()
        catalog.confirm(try TestData.settings(TestData.settingsObject(dailyBudgetUsd: 25, overridden: ["dailyBudgetUsd"])), requestedAt: catalog.revision)
        catalog.finishSending()
        XCTAssertEqual(catalog.dailyBudgetUsd, 25)
        XCTAssertEqual(catalog.overridden, [SettingKey.dailyBudgetUsd])
        XCTAssertEqual(catalog.spentTodayUsd, 2)
    }

    func testALaterChangeToTheSameSettingWinsOverOneInFlight() throws {
        var catalog = try loaded()
        catalog.stage(SettingsChanges(dailyBudgetUsd: 25))
        _ = catalog.beginSending()
        catalog.stage(SettingsChanges(dailyBudgetUsd: 30))
        XCTAssertEqual(catalog.dailyBudgetUsd, 30)
        catalog.finishSending()
        XCTAssertEqual(catalog.dailyBudgetUsd, 30, "the newer change is still waiting to be sent")
        XCTAssertEqual(catalog.beginSending(), SettingsChanges(dailyBudgetUsd: 30))
    }

    func testChangesBeforeTheyAreSentMergeIntoOne() throws {
        var catalog = try loaded()
        catalog.stage(SettingsChanges(dailyBudgetUsd: 25))
        catalog.stage(SettingsChanges(dailyBudgetUsd: 30, runBudgetUsd: 5))
        catalog.stage(SettingsChanges(dailyBudgetUsd: 35))
        XCTAssertEqual(catalog.beginSending(), SettingsChanges(dailyBudgetUsd: 35, runBudgetUsd: 5))
    }

    func testTheIdeaTimeHasThreeStates() throws {
        var catalog = try loaded(TestData.settingsObject(ideasAt: "08:00"))
        XCTAssertEqual(catalog.ideasAt, TimeOfDay(hour: 8, minute: 0), "untouched")

        catalog.stage(SettingsChanges(ideasAt: .at(TimeOfDay(hour: 21, minute: 15))))
        XCTAssertEqual(catalog.ideasAt, TimeOfDay(hour: 21, minute: 15), "set to a time")

        catalog.stage(SettingsChanges(ideasAt: .off))
        XCTAssertNil(catalog.ideasAt, "turned off")

        var off = try loaded(TestData.settingsObject(ideasAt: nil))
        off.stage(SettingsChanges(ideasAt: .at(TimeOfDay(hour: 8, minute: 0))))
        XCTAssertEqual(off.ideasAt, TimeOfDay(hour: 8, minute: 0), "turned on")
    }

    func testResettingEverythingIsSentAsItIsAndShowsNothingBeforeTheAnswer() throws {
        var catalog = try loaded(TestData.settingsObject(model: "haiku", dailyBudgetUsd: 30, overridden: ["model", "dailyBudgetUsd"]))
        catalog.stage(SettingsChanges(reset: SettingsPresentation.keys))
        XCTAssertEqual(catalog.model, .haiku, "the default is Alfred's to say")
        XCTAssertEqual(catalog.beginSending()?.reset, SettingsPresentation.keys)
    }

    // MARK: Merging changes

    func testALaterValueReplacesAnEarlierOne() {
        let merged = SettingsChanges(model: .opus, compactTokens: 200_000).merged(with: SettingsChanges(model: .haiku))
        XCTAssertEqual(merged, SettingsChanges(model: .haiku, compactTokens: 200_000))
    }

    func testAResetTakesBackAnEarlierValueAndASettingTakesBackAReset() {
        let reset = SettingsChanges(model: .opus, dailyBudgetUsd: 30).merged(with: SettingsChanges(reset: [.model]))
        XCTAssertEqual(reset, SettingsChanges(dailyBudgetUsd: 30, reset: [.model]))

        let set = reset.merged(with: SettingsChanges(model: .haiku))
        XCTAssertEqual(set, SettingsChanges(model: .haiku, dailyBudgetUsd: 30))
    }

    func testTheResetListHasNoRepeats() {
        let merged = SettingsChanges(reset: [.model, .dailyBudgetUsd]).merged(with: SettingsChanges(reset: [.dailyBudgetUsd, .runBudgetUsd]))
        XCTAssertEqual(merged.reset, [.model, .dailyBudgetUsd, .runBudgetUsd])
    }

    func testTheIdeaTimeMergesLikeAnyOtherSetting() {
        let merged = SettingsChanges(ideasAt: .off).merged(with: SettingsChanges(ideasAt: .at(TimeOfDay(hour: 9, minute: 0))))
        XCTAssertEqual(merged.ideasAt, .at(TimeOfDay(hour: 9, minute: 0)))
        XCTAssertEqual(SettingsChanges(ideasAt: .off).merged(with: SettingsChanges(reset: [.ideasAt])), SettingsChanges(reset: [.ideasAt]))
    }
}
