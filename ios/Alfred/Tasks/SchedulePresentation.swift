import AlfredKit
import Foundation

/// A task's schedule in words: `每天 08:00`, `每周一、三、五 08:00`, `每个工作日 08:00`, `每 6 小时`,
/// `10月28日 09:00 一次`.
///
/// A time of day and the weekdays are in the owner's zone (the zone `GET /api/tasks` names), whatever zone the device
/// is in. When the device's clock reads differently, those schedules say whose time it is: `每天 08:00（台北时间）`.
/// A one-time run is an instant, so it shows on the device's own clock and needs no note.
enum SchedulePresentation {
    private static let weekdayNames = ["一", "二", "三", "四", "五", "六", "日"]

    static func words(_ schedule: Schedule, ownerZone: String?, deviceZone: TimeZone = .current, now: Date = Date()) -> String {
        let note = zoneNote(ownerZone: ownerZone, deviceZone: deviceZone, now: now).map { "（\($0)）" } ?? ""
        switch schedule {
        case let .daily(time):
            return "每天 \(clock(time))\(note)"
        case let .weekly(days, time):
            return "\(weekdays(days)) \(clock(time))\(note)"
        case let .interval(hours):
            return "每 \(hours) 小时"
        case let .once(at):
            return "\(RunPresentation.dateTime(at, in: deviceZone)) 一次"
        }
    }

    /// Whose clock a time of day is on, when it is not the device's: the owner's city and `时间`, as in `台北时间`.
    /// Two zones count as the same when they have the same name, or the same offset from UTC at `now`: the clocks then
    /// read alike.
    static func zoneNote(ownerZone: String?, deviceZone: TimeZone, now: Date = Date()) -> String? {
        guard let ownerZone, let owner = TimeZone(identifier: ownerZone),
              owner.identifier != deviceZone.identifier,
              owner.secondsFromGMT(for: now) != deviceZone.secondsFromGMT(for: now)
        else { return nil }
        return city(of: owner)
    }

    /// `08:00`.
    static func clock(_ time: TimeOfDay) -> String {
        String(format: "%02d:%02d", time.hour, time.minute)
    }

    /// `每周一、三、五`, `每个工作日` for Monday to Friday and `每天` for all seven days.
    private static func weekdays(_ days: [Int]) -> String {
        let set = Set(days.filter { (1...7).contains($0) })
        if set.count == 7 { return "每天" }
        if set == [1, 2, 3, 4, 5] { return "每个工作日" }
        return "每周" + set.sorted().map { weekdayNames[$0 - 1] }.joined(separator: "、")
    }

    /// `台北时间`. The city is the zone's exemplar city in Chinese; a zone without one (`UTC`) goes by its own name.
    private static func city(of zone: TimeZone) -> String {
        let parts = zone.identifier.split(separator: "/")
        if parts.count > 1, parts.first != "Etc" {
            let formatter = DateFormatter()
            formatter.locale = Locale(identifier: "zh-Hans")
            formatter.timeZone = zone
            formatter.dateFormat = "VVV"
            return formatter.string(from: Date()) + "时间"
        }
        return (parts.last.map(String.init) ?? zone.identifier).replacingOccurrences(of: "_", with: " ") + " 时间"
    }
}
