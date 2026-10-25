import Foundation

/// What the app keeps to reach Alfred: the server, the Cloudflare Access service token and the device token.
/// It is stored as JSON, so it can sit in the keychain.
public struct Credentials: Codable, Hashable, Sendable {
    public let server: URL
    public let accessClientId: String
    public let accessClientSecret: String
    public let deviceId: String
    public let deviceToken: String

    public init(pairing: Pairing) {
        server = pairing.server
        accessClientId = pairing.access.clientId
        accessClientSecret = pairing.access.clientSecret
        deviceId = pairing.device.id
        deviceToken = pairing.device.token
    }
}
