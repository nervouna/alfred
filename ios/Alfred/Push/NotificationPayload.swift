import Foundation
import UserNotifications

/// What a notification from Alfred points at. The workbench puts `eventId` in the payload, and `runId` when the message
/// came from a run (see `src/workbench/push.ts`).
struct NotificationTarget: Equatable, Sendable {
    /// The stored event the notification is about: a message, or a question.
    let eventId: Int64?
    let runId: String?

    init(eventId: Int64?, runId: String?) {
        self.eventId = eventId
        self.runId = runId
    }

    /// Reads the payload's custom keys. A key of the wrong type, or an event id that is not a positive whole number,
    /// is ignored.
    init(userInfo: [AnyHashable: Any]) {
        eventId = Self.eventId(userInfo["eventId"])
        runId = (userInfo["runId"] as? String).flatMap { $0.isEmpty ? nil : $0 }
    }

    private static func eventId(_ value: Any?) -> Int64? {
        let id: Int64?
        switch value {
        // A JSON number arrives as an NSNumber: a boolean is one too, and a fraction must not become a whole number.
        case let number as NSNumber:
            guard CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue == Double(number.int64Value) else { return nil }
            id = number.int64Value
        case let text as String:
            id = Int64(text)
        default:
            id = nil
        }
        return id.flatMap { $0 > 0 ? $0 : nil }
    }
}

/// What the app does with a notification that arrives while it is open.
enum NotificationPresentation {
    /// Nothing while the chat is on screen, because the chat already shows the message; a banner with sound otherwise.
    static func options(chatVisible: Bool) -> UNNotificationPresentationOptions {
        chatVisible ? [] : [.banner, .sound]
    }
}
