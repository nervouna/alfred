import Foundation

/// The payload of the pairing QR code: where the app reaches Alfred, the Cloudflare Access service token
/// and the device token. Decoding fails for another `version`, or for a server that is not an https origin.
public struct Pairing: Decodable, Hashable, Sendable {
    public struct Access: Decodable, Hashable, Sendable {
        public let clientId: String
        public let clientSecret: String
    }

    public struct Device: Decodable, Hashable, Sendable {
        public let id: String
        public let token: String
    }

    public let server: URL
    public let access: Access
    public let device: Device

    private enum CodingKeys: String, CodingKey {
        case version, server, access, device
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let version = try container.decode(Int.self, forKey: .version)
        guard version == 1 else {
            throw DecodingError.dataCorruptedError(
                forKey: .version,
                in: container,
                debugDescription: "unsupported pairing version \(version)"
            )
        }
        let text = try container.decode(String.self, forKey: .server)
        guard isHTTPSOrigin(text), let server = URL(string: text) else {
            throw DecodingError.dataCorruptedError(
                forKey: .server,
                in: container,
                debugDescription: "\(text) is not an https origin"
            )
        }
        self.server = server
        access = try container.decode(Access.self, forKey: .access)
        device = try container.decode(Device.self, forKey: .device)
    }
}

/// True for `https://host[:port]` only: no path, query, fragment or user information.
private func isHTTPSOrigin(_ text: String) -> Bool {
    guard let parts = URLComponents(string: text) else { return false }
    return parts.scheme == "https"
        && parts.host?.isEmpty == false
        && parts.user == nil
        && parts.password == nil
        && parts.path.isEmpty
        && parts.query == nil
        && parts.fragment == nil
}
