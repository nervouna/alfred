import UIKit
import UserNotifications

/// What the owner has let Alfred do with notifications.
enum NotificationAuthorization: Hashable {
    /// Notifications may be shown (a provisional authorization counts: they arrive quietly).
    case allowed
    /// The owner refused, or turned them off in the system's settings.
    case denied
    /// The system has not asked yet.
    case notDetermined
}

/// What the app asks of the system for notifications, behind a protocol so tests can watch the asking.
@MainActor
protocol PushSystem {
    /// Asks the owner for permission to show alerts, play sounds and badge the icon. The system asks once; after that
    /// it only answers.
    func requestAuthorization()
    /// Asks the system for an APNs device token, which arrives at the app delegate.
    func registerForRemoteNotifications()
    func unregisterForRemoteNotifications()
    /// What the owner has allowed right now. The owner can change it in the system's settings at any time.
    func authorization() async -> NotificationAuthorization
    /// Opens the system's settings for this app's notifications.
    func openNotificationSettings()
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

    func authorization() async -> NotificationAuthorization {
        switch await UNUserNotificationCenter.current().notificationSettings().authorizationStatus {
        case .authorized, .provisional, .ephemeral: .allowed
        case .denied: .denied
        case .notDetermined: .notDetermined
        @unknown default: .notDetermined
        }
    }

    func openNotificationSettings() {
        guard let url = URL(string: UIApplication.openNotificationSettingsURLString) else { return }
        UIApplication.shared.open(url)
    }
}

/// A system that does nothing, for a model that is not the app's own.
@MainActor
struct NoPushSystem: PushSystem {
    func requestAuthorization() {}
    func registerForRemoteNotifications() {}
    func unregisterForRemoteNotifications() {}
    func authorization() async -> NotificationAuthorization { .notDetermined }
    func openNotificationSettings() {}
}
