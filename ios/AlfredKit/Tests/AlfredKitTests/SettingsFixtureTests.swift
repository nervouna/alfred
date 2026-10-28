import AlfredKit
import Foundation
import XCTest

final class SettingsFixtureTests: XCTestCase {
    private func decodeEvent(_ name: String) throws -> Event {
        try JSONDecoder().decode(Event.self, from: Data(contentsOf: Fixtures.directory.appending(path: name)))
    }

    private func decodeCommand(_ name: String) throws -> Command {
        try JSONDecoder().decode(Command.self, from: Data(contentsOf: Fixtures.directory.appending(path: name)))
    }

    private func decodeFixture<T: Decodable>(_ type: T.Type, _ name: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(contentsOf: Fixtures.directory.appending(path: name)))
    }

    func testTheSettingsUpdatedEventCarriesTheWholeSettings() throws {
        let event = try decodeEvent("events/settings-updated.json")
        guard case let .settingsUpdated(settings) = event.payload else {
            return XCTFail("expected a settings.updated event, got \(event.payload)")
        }
        XCTAssertEqual(settings.model, .opus)
        XCTAssertEqual(settings.dailyBudgetUsd, 30)
        XCTAssertEqual(settings.runBudgetUsd, 10)
        XCTAssertEqual(settings.sessionIdleHours, 4)
        XCTAssertEqual(settings.compactTokens, 100_000)
        XCTAssertEqual(settings.memoryScanMinutes, 60)
        XCTAssertEqual(settings.memoryScanBudgetUsd, 0.1)
        XCTAssertEqual(settings.ideasAt, TimeOfDay(hour: 8, minute: 0))
        XCTAssertEqual(settings.overridden, [.model, .dailyBudgetUsd])
    }

    func testSettingsResultTurnsTheIdeasTimeOffToNil() throws {
        let result = try decodeFixture(SettingsResult.self, "responses/settings-result.json")
        XCTAssertNil(result.settings.ideasAt)
        XCTAssertEqual(result.settings.overridden, [.model, .dailyBudgetUsd, .ideasAt])
    }

    func testSettingsDetailCarriesTheSpendToday() throws {
        let detail = try decodeFixture(SettingsDetail.self, "responses/settings-detail.json")
        XCTAssertEqual(detail.spentTodayUsd, 4.82)
        XCTAssertEqual(detail.settings.model, .opus)
        XCTAssertNil(detail.settings.ideasAt)
    }

    func testAResponseKeepsAValueBeyondTheCommandsRange() throws {
        let result = try decodeFixture(SettingsResult.self, "responses/settings-result-beyond-ranges.json")
        XCTAssertEqual(result.settings.dailyBudgetUsd, 150)
        XCTAssertEqual(result.settings.overridden, [])
    }

    func testSettingsUpdateCommandsCarryTheirChanges() throws {
        XCTAssertEqual(
            try decodeCommand("commands/settings-update.json"),
            .settingsUpdate(SettingsChanges(model: .opus, dailyBudgetUsd: 30, reset: [.runBudgetUsd]))
        )
        XCTAssertEqual(
            try decodeCommand("commands/settings-update-ideas-off.json"),
            .settingsUpdate(SettingsChanges(ideasAt: .off))
        )
        XCTAssertEqual(
            try decodeCommand("commands/settings-update-reset-all.json"),
            .settingsUpdate(SettingsChanges(reset: [
                .model, .dailyBudgetUsd, .runBudgetUsd, .sessionIdleHours,
                .compactTokens, .memoryScanMinutes, .memoryScanBudgetUsd, .ideasAt,
            ]))
        )
    }

    func testAnUntouchedIdeasTimeIsLeftOutAndOffIsNull() throws {
        let untouched = try json(.settingsUpdate(SettingsChanges(dailyBudgetUsd: 30)))
        XCTAssertNil(untouched["ideasAt"])
        XCTAssertEqual(untouched["dailyBudgetUsd"] as? Double, 30)

        let off = try json(.settingsUpdate(SettingsChanges(ideasAt: .off)))
        XCTAssertTrue(off["ideasAt"] is NSNull)

        let time = try json(.settingsUpdate(SettingsChanges(ideasAt: .at(TimeOfDay(hour: 9, minute: 5)))))
        XCTAssertEqual(time["ideasAt"] as? String, "09:05")
    }

    func testAnUnknownSettingKeyDecodesAsItself() throws {
        let text = """
        {"settings":{"model":"sonnet","dailyBudgetUsd":20,"runBudgetUsd":10,"sessionIdleHours":4,"compactTokens":0,"memoryScanMinutes":60,"memoryScanBudgetUsd":0.1,"ideasAt":"08:00","overridden":["temperature"]}}
        """
        let result = try JSONDecoder().decode(SettingsResult.self, from: Data(text.utf8))
        XCTAssertEqual(result.settings.overridden.map(\.rawValue), ["temperature"])
    }

    /// The JSON object a command encodes to.
    private func json(_ command: Command) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(command)) as? [String: Any])
    }
}
