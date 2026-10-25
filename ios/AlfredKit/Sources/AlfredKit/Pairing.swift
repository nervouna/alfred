import Foundation

/// The payload of the pairing QR code: where the app reaches Alfred, the Cloudflare Access service token
/// and the device token. Decoding fails for another `version`, or for a server that is not an https origin
/// (or an http one on 127.0.0.1 or localhost, for local work).
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
        guard isServerOrigin(text), let server = URL(string: text) else {
            throw DecodingError.dataCorruptedError(
                forKey: .server,
                in: container,
                debugDescription: "\(text) is not an https origin, or an http origin on 127.0.0.1 or localhost"
            )
        }
        self.server = server
        access = try container.decode(Access.self, forKey: .access)
        device = try container.decode(Device.self, forKey: .device)
    }
}

/// True for `https://host[:port]`, and for `http://127.0.0.1[:port]` and `http://localhost[:port]`, with no
/// path, query, fragment or user information.
private func isServerOrigin(_ text: String) -> Bool {
    guard let parts = URLComponents(string: text), let host = parts.host, !host.isEmpty else { return false }
    guard parts.user == nil,
          parts.password == nil,
          parts.path.isEmpty,
          parts.query == nil,
          parts.fragment == nil
    else { return false }
    switch parts.scheme {
    case "https": return true
    case "http": return host == "127.0.0.1" || host == "localhost"
    default: return false
    }
}
