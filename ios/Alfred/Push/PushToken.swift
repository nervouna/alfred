import AlfredKit
import Foundation

/// The device token and the gateway it belongs to, in the form Alfred stores them.
enum PushToken {
    /// The token as lowercase hex.
    static func hex(_ token: Data) -> String {
        token.map { String(format: "%02x", $0) }.joined()
    }

    /// The APNs environment the build registers with, from the `AlfredAPNsEnvironment` Info.plist value. A build signed
    /// with a development profile has `aps-environment` `development`, so its tokens belong to the sandbox gateway.
    /// A missing or unknown value is no environment, and the app registers nothing rather than guess.
    static func environment(infoValue: Any?) -> PushEnvironment? {
        (infoValue as? String).flatMap(PushEnvironment.init(rawValue:))
    }

    static func environment(bundle: Bundle = .main) -> PushEnvironment? {
        environment(infoValue: bundle.object(forInfoDictionaryKey: "AlfredAPNsEnvironment"))
    }
}
