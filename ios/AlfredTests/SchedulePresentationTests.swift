import AlfredKit
import XCTest

@testable import Alfred

final class SchedulePresentationTests: XCTestCase {
    private let taipei = TimeZone(identifier: "Asia/Taipei")!
    private let newYork = TimeZone(identifier: "America/New_York")!
    private let shanghai = TimeZone(identifier: "Asia/Shanghai")!
    /// A fixed day in October, when New York keeps daylight saving time and Taipei is 12 hours ahead of it.
    private let now = Date(timeIntervalSince1970: 1_792_000_000)

    private func words(_ schedule: Schedule, owner: String? = "Asia/Taipei", device: TimeZone? = nil) -> String {
        SchedulePresentation.words(schedule, ownerZone: owner, deviceZone: device ?? taipei, now: now)
    }

    func testADailyScheduleSaysEveryDayAtItsTime() {
        XCTAssertEqual(words(.daily(time: TimeOfDay(hour: 8, minute: 0))), "每天 08:00")
        XCTAssertEqual(words(.daily(time: TimeOfDay(hour: 23, minute: 5))), "每天 23:05")
    }

    func testAWeeklyScheduleNamesItsWeekdays() {
        let time = TimeOfDay(hour: 8, minute: 0)
        XCTAssertEqual(words(.weekly(days: [1, 3, 5], time: time)), "每周一、三、五 08:00")
        XCTAssertEqual(words(.weekly(days: [6, 7], time: TimeOfDay(hour: 10, minute: 30))), "每周六、日 10:30")
        XCTAssertEqual(words(.weekly(days: [2], time: time)), "每周二 08:00")
    }

    func testMondayToFridayIsEveryWorkday() {
        XCTAssertEqual(words(.weekly(days: [1, 2, 3, 4, 5], time: TimeOfDay(hour: 8, minute: 0))), "每个工作日 08:00")
    }

    func testAllSevenWeekdaysIsEveryDay() {
        XCTAssertEqual(words(.weekly(days: [1, 2, 3, 4, 5, 6, 7], time: TimeOfDay(hour: 8, minute: 0))), "每天 08:00")
    }

    func testWeekdaysAreListedInOrderOnce() {
        XCTAssertEqual(words(.weekly(days: [5, 1, 3, 3], time: TimeOfDay(hour: 8, minute: 0))), "每周一、三、五 08:00")
    }

    func testAnIntervalSaysItsHours() {
        XCTAssertEqual(words(.interval(hours: 6)), "每 6 小时")
        XCTAssertEqual(words(.interval(hours: 168)), "每 168 小时")
    }

    func testAOneTimeScheduleSaysItsDateAndTimeOnTheDevicesClock() throws {
        let at = try Date.ISO8601FormatStyle().parse("2026-10-28T01:00:00Z")
        XCTAssertEqual(words(.once(at: at)), "10月28日 09:00 一次")
        XCTAssertEqual(words(.once(at: at), device: newYork), "10月27日 21:00 一次", "an instant shows on the device's own clock, with no zone note")
    }

    // MARK: The zone note

    func testATimeOfDayNamesTheOwnersCityWhenTheDeviceIsElsewhere() {
        let time = TimeOfDay(hour: 8, minute: 0)
        XCTAssertEqual(words(.daily(time: time), device: newYork), "每天 08:00（台北时间）")
        XCTAssertEqual(words(.weekly(days: [1, 3, 5], time: time), device: newYork), "每周一、三、五 08:00（台北时间）")
        XCTAssertEqual(words(.weekly(days: [1, 2, 3, 4, 5], time: time), device: newYork), "每个工作日 08:00（台北时间）")
    }

    func testNoNoteWhenTheDeviceIsInTheOwnersZone() {
        XCTAssertEqual(words(.daily(time: TimeOfDay(hour: 8, minute: 0))), "每天 08:00")
    }

    func testNoNoteWhenTheDevicesClockReadsTheSame() {
        // Another zone that is 8 hours ahead of UTC all year: the same wall clock.
        XCTAssertEqual(words(.daily(time: TimeOfDay(hour: 8, minute: 0)), device: shanghai), "每天 08:00")
    }

    func testNoNoteWithoutATimeOfDay() {
        XCTAssertEqual(words(.interval(hours: 6), device: newYork), "每 6 小时")
    }

    func testNoNoteWhenTheOwnersZoneIsNotKnown() {
        let time = TimeOfDay(hour: 8, minute: 0)
        XCTAssertEqual(words(.daily(time: time), owner: nil, device: newYork), "每天 08:00")
        XCTAssertEqual(words(.daily(time: time), owner: "Not/AZone", device: newYork), "每天 08:00")
    }

    func testTheNoteNamesTheCity() {
        XCTAssertEqual(SchedulePresentation.zoneNote(ownerZone: "Asia/Taipei", deviceZone: newYork, now: now), "台北时间")
        XCTAssertEqual(SchedulePresentation.zoneNote(ownerZone: "America/New_York", deviceZone: taipei, now: now), "纽约时间")
        XCTAssertEqual(SchedulePresentation.zoneNote(ownerZone: "UTC", deviceZone: taipei, now: now), "GMT 时间", "a zone with no city is named as the system names it")
        XCTAssertNil(SchedulePresentation.zoneNote(ownerZone: "Asia/Taipei", deviceZone: taipei, now: now))
    }
}
