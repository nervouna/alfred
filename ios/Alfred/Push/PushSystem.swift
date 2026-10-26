import UIKit
import UserNotifications

/// What the app asks of the system for notifications, behind a protocol so tests can watch the asking.
@MainActor
protocol PushSystem {
    /// Asks the owner for permission to show alerts, play sounds and badge the icon. The system asks once; after that
    /// it only answers.
    func requestAuthorization()
    /// Asks the system for an APNs device token, which arrives at the app delegate.
    func registerForRemoteNotifications()
    func unregisterForRemoteNotifications()
}

/// The system for real.
@MainActor
struct LivePushSystem: PushSystem {
    func requestAuthorization() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in }
    }

    func registerForRemoteNotifications() {
        UIApplication.shared.registerForRemoteNotifications()
    }

    func unregisterForRemoteNotifications() {
        UIApplication.shared.unregisterForRemoteNotifications()
    }
}

/// A system that does nothing, for a model that is not the app's own.
@MainActor
struct NoPushSystem: PushSystem {
    func requestAuthorization() {}
    func registerForRemoteNotifications() {}
    func unregisterForRemoteNotifications() {}
}
