import AlfredKit
import Foundation

/// Where the app keeps its credentials. The Share Extension reads the same item, so both build the store here.
enum AppKeychain {
    static let service = "alfred"

    /// The access group the app and the Share Extension share, from the `AlfredKeychainAccessGroup` Info.plist
    /// value, which the build fills in as `$(AppIdentifierPrefix)$(ALFRED_BUNDLE_ID)`. A simulator build without
    /// signing has no entitlements, so there is no group; neither is there one when the build left the value empty
    /// or unexpanded.
    static func accessGroup(infoValue: Any?, simulator: Bool) -> String? {
        if simulator { return nil }
        guard let group = infoValue as? String, !group.isEmpty, !group.contains("$(") else { return nil }
        return group
    }

    static func store(bundle: Bundle = .main) -> KeychainCredentialStore {
        #if targetEnvironment(simulator)
        let simulator = true
        #else
        let simulator = false
        #endif
        let group = accessGroup(infoValue: bundle.object(forInfoDictionaryKey: "AlfredKeychainAccessGroup"), simulator: simulator)
        return KeychainCredentialStore(service: service, accessGroup: group)
    }
}
