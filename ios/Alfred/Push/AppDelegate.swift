import UIKit
@preconcurrency import UserNotifications

/// Owns the model, and takes what only a delegate receives: the APNs token and the notifications. Everything it
/// decides lives in `AppModel`, `PushToken` and `NotificationPresentation`.
///
/// The notification methods stay on the main actor: the system's completion handler, which UIKit then acts on, has to be
/// called there, and a `nonisolated` async method would call it from a background thread.
final class AppDelegate: NSObject, UIApplicationDelegate, @preconcurrency UNUserNotificationCenterDelegate {
    let model = AppModel.live()

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        // Set before the app finishes launching, so a notification that started the app is delivered to it.
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        Task { await model.registerPushToken(deviceToken) }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: any Error) {
        // Nothing to do: the next launch asks again.
    }

    /// A notification arrives while the app is open.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        NotificationPresentation.options(chatVisible: model.isChatVisible)
    }

    /// The owner tapped a notification.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        model.openChat(for: NotificationTarget(userInfo: response.notification.request.content.userInfo))
    }
}
