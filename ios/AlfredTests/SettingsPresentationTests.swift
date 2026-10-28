import AlfredKit
import XCTest

@testable import Alfred

final class SettingsPresentationTests: XCTestCase {
    // MARK: Words and units

    func testTheModelsAreNamedAndAnUnknownOneIsItsKey() {
        XCTAssertEqual(SettingsPresentation.modelName(.sonnet), "Sonnet")
        XCTAssertEqual(SettingsPresentation.modelName(.opus), "Opus")
        XCTAssertEqual(SettingsPresentation.modelName(.haiku), "Haiku")
        XCTAssertEqual(SettingsPresentation.modelName(TaskModel(rawValue: "mystery")), "mystery")
    }

    func testCapsHaveTwoDecimalsAndSpendHasMoreUnderADollar() {
        XCTAssertEqual(SettingsPresentation.cap(20), "$20.00")
        XCTAssertEqual(SettingsPresentation.cap(0.1), "$0.10")
        XCTAssertEqual(SettingsPresentation.spent(0), "$0.000")
        XCTAssertEqual(SettingsPresentation.spent(0.4237), "$0.424")
        XCTAssertEqual(SettingsPresentation.spent(12.5), "$12.50")
    }

    func testIdleHoursAreOffAtZero() {
        XCTAssertEqual(SettingsPresentation.idleHours(0), "关")
        XCTAssertEqual(SettingsPresentation.idleHours(4), "4 小时")
        XCTAssertEqual(SettingsPresentation.idleHours(1.5), "1.5 小时")
        XCTAssertEqual(SettingsPresentation.idleHours(168), "168 小时")
    }

    func testTheScanIntervalIsOffAtZeroAndInHoursWhenWhole() {
        XCTAssertEqual(SettingsPresentation.scanInterval(0), "关")
        XCTAssertEqual(SettingsPresentation.scanInterval(15), "15 分钟")
        XCTAssertEqual(SettingsPresentation.scanInterval(60), "1 小时")
        XCTAssertEqual(SettingsPresentation.scanInterval(90), "90 分钟")
        XCTAssertEqual(SettingsPresentation.scanInterval(1440), "24 小时")
    }

    func testTheCompactionSizeIsInThousandsOrAuto() {
        XCTAssertEqual(SettingsPresentation.compactTokens(100_000), "100k")
        XCTAssertEqual(SettingsPresentation.compactTokens(200_000), "200k")
        XCTAssertEqual(SettingsPresentation.compactTokens(150_000), "150k")
        XCTAssertEqual(SettingsPresentation.compactTokens(0), "自动")
        XCTAssertEqual(SettingsPresentation.compactTokens(123_456), "123456", "a size that is not a whole thousand is shown as it is")
    }

    // MARK: Tiers

    func testTheCompactionEntriesAreTheThreeTheAppSends() {
        XCTAssertEqual(SettingsPresentation.compactTokensChoices(current: 100_000), [100_000, 200_000, 0])
        XCTAssertEqual(SettingsPresentation.compactTokensChoices(current: nil), [100_000, 200_000, 0])
    }

    func testADeploymentsSizeIsPutAmongThem() {
        XCTAssertEqual(SettingsPresentation.compactTokensChoices(current: 150_000), [100_000, 150_000, 200_000, 0])
        XCTAssertEqual(SettingsPresentation.compactTokensChoices(current: 20_000).map(SettingsPresentation.compactTokens), ["20k", "100k", "200k", "自动"])
    }

    func testTheModelsOfferedAreTheThreeAndTheCurrentOneIfItIsAnother() {
        XCTAssertEqual(SettingsPresentation.modelChoices(current: nil), [.sonnet, .opus, .haiku])
        XCTAssertEqual(SettingsPresentation.modelChoices(current: .haiku), [.sonnet, .opus, .haiku])
        XCTAssertEqual(SettingsPresentation.modelChoices(current: TaskModel(rawValue: "x")), [.sonnet, .opus, .haiku, TaskModel(rawValue: "x")])
    }

    func testEverySettingIsAKeyOnceInTheContractsOrder() {
        XCTAssertEqual(
            SettingsPresentation.keys.map(\.rawValue),
            ["model", "dailyBudgetUsd", "runBudgetUsd", "sessionIdleHours", "compactTokens", "memoryScanMinutes", "memoryScanBudgetUsd", "ideasAt"]
        )
    }

    // MARK: Ranges

    func testTheStepperRangesAreTheContractsWriteRanges() {
        XCTAssertEqual(SettingsPresentation.dailyBudget.bounds, 1...100)
        XCTAssertEqual(SettingsPresentation.runBudget.bounds, 1...20)
        XCTAssertEqual(SettingsPresentation.sessionIdleHours.bounds, 0...168)
        XCTAssertEqual(SettingsPresentation.memoryScanMinutes.bounds, 0...1440)
        XCTAssertGreaterThan(SettingsPresentation.memoryScanBudget.bounds.lowerBound, 0, "the scan budget is above 0")
        XCTAssertEqual(SettingsPresentation.memoryScanBudget.bounds.upperBound, 1)
    }

    func testAValueIsBroughtIntoItsRange() {
        XCTAssertEqual(SettingsPresentation.dailyBudget.normalized(150), 100, "a deployment may set more than the app writes")
        XCTAssertEqual(SettingsPresentation.dailyBudget.normalized(-5), 1)
        XCTAssertEqual(SettingsPresentation.sessionIdleHours.normalized(-1), 0)
        XCTAssertEqual(SettingsPresentation.memoryScanBudget.normalized(0), 0.05)
        XCTAssertEqual(SettingsPresentation.memoryScanBudget.normalized(1.2), 1)
    }

    func testAddingAStepLeavesNoFloatingPointDust() {
        let range = SettingsPresentation.memoryScanBudget
        XCTAssertEqual(range.normalized(0.1 + range.step), 0.15)
        XCTAssertEqual(range.normalized(0.15 + range.step), 0.2)
        XCTAssertEqual(SettingsPresentation.dailyBudget.normalized(7.5 + 5), 12.5, "an odd value from the deployment keeps its fraction")
    }

    func testEveryStepStaysInsideItsRange() {
        for range in [
            SettingsPresentation.dailyBudget, SettingsPresentation.runBudget, SettingsPresentation.sessionIdleHours,
            SettingsPresentation.memoryScanMinutes, SettingsPresentation.memoryScanBudget,
        ] {
            XCTAssertGreaterThan(range.step, 0)
            XCTAssertLessThan(range.step, range.bounds.upperBound - range.bounds.lowerBound)
        }
    }

    // MARK: Notifications

    func testTheNotificationStateReadsAsTheOwnerWouldSayIt() {
        XCTAssertEqual(SettingsPresentation.authorizationLabel(.allowed), "已开启")
        XCTAssertEqual(SettingsPresentation.authorizationLabel(.denied), "已关闭")
        XCTAssertEqual(SettingsPresentation.authorizationLabel(.notDetermined), "未询问")
        XCTAssertEqual(SettingsPresentation.authorizationLabel(nil), "—", "the system has not answered yet")
    }

    // MARK: Time of day

    func testATimeOfDayRoundTripsThroughThePicker() {
        for (hour, minute) in [(0, 0), (8, 0), (9, 5), (12, 30), (23, 59)] {
            let time = TimeOfDay(hour: hour, minute: minute)
            XCTAssertEqual(SettingsPresentation.time(of: SettingsPresentation.date(for: time)), time)
        }
    }

    func testATimeOfDayDoesNotDependOnThePhonesZone() {
        let saved = NSTimeZone.default
        defer { NSTimeZone.default = saved }
        for name in ["Asia/Taipei", "America/New_York", "Pacific/Auckland"] {
            NSTimeZone.default = TimeZone(identifier: name) ?? .gmt
            let time = TimeOfDay(hour: 2, minute: 30)
            XCTAssertEqual(SettingsPresentation.time(of: SettingsPresentation.date(for: time)), time, name)
        }
    }

    func testATimeIsWrittenAsTheContractHasIt() {
        XCTAssertEqual(SettingsPresentation.timeText(TimeOfDay(hour: 8, minute: 0)), "08:00")
        XCTAssertEqual(SettingsPresentation.timeText(TimeOfDay(hour: 21, minute: 5)), "21:05")
        XCTAssertEqual(SettingsPresentation.defaultIdeasAt, TimeOfDay(hour: 8, minute: 0))
    }

    // MARK: The device and the app

    func testTheServerIsShownAsItsHost() throws {
        XCTAssertEqual(SettingsPresentation.serverHost(try XCTUnwrap(URL(string: "https://alfred.example.com"))), "alfred.example.com")
        XCTAssertEqual(SettingsPresentation.serverHost(try XCTUnwrap(URL(string: "http://127.0.0.1:8787"))), "127.0.0.1")
        XCTAssertEqual(SettingsPresentation.serverHost(try XCTUnwrap(URL(string: "https://alfred.example.com/base/path"))), "alfred.example.com")
    }

    func testTheVersionIsTheShortVersionAndTheBuild() {
        XCTAssertEqual(SettingsPresentation.version(["CFBundleShortVersionString": "1.2", "CFBundleVersion": "34"]), "1.2 (34)")
        XCTAssertEqual(SettingsPresentation.version(["CFBundleShortVersionString": "1.2"]), "1.2")
        XCTAssertEqual(SettingsPresentation.version(["CFBundleVersion": "34"]), "(34)")
        XCTAssertEqual(SettingsPresentation.version([:]), "—")
        XCTAssertEqual(SettingsPresentation.version(nil), "—")
    }

    func testTheBuiltAppHasAVersionAndABuild() {
        let text = SettingsPresentation.version(Bundle.main.infoDictionary)
        XCTAssertTrue(text.contains("("), "the bundle has no CFBundleVersion: \(text)")
    }

    // MARK: Failures

    func testASaveFailureSaysWhyWithTheServersWords() {
        XCTAssertEqual(
            SettingsPresentation.saveFailure(AlfredError.http(status: 400, message: "dailyBudgetUsd 超出范围")),
            "设置没有保存：dailyBudgetUsd 超出范围"
        )
        XCTAssertEqual(SettingsPresentation.saveFailure(AlfredError.http(status: 503, message: nil)), "设置没有保存：服务器返回 503")
        XCTAssertEqual(SettingsPresentation.saveFailure(AlfredError.unauthorized), "设置没有保存：这台设备已被撤销，请重新配对")
    }
}
