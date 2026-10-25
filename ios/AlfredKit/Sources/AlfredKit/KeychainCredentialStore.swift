import Foundation
import Security

/// A keychain call that failed, with its Security status.
public struct KeychainError: Error, Hashable, Sendable {
    public let status: OSStatus
}

/// Keeps the credentials in one generic-password item. The query builders are separate from the calls that run
/// them, so tests can inspect the dictionaries without touching the keychain.
public struct KeychainCredentialStore: CredentialStore {
    static let account = "device"

    public let service: String
    /// The keychain access group, when the app and the Share Extension share the item.
    public let accessGroup: String?

    public init(service: String, accessGroup: String? = nil) {
        self.service = service
        self.accessGroup = accessGroup
    }

    /// The query that finds the item.
    func itemQuery() -> [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword as Any,
            kSecAttrService as String: service,
            kSecAttrAccount as String: Self.account,
        ]
        if let accessGroup {
            query[kSecAttrAccessGroup as String] = accessGroup
        }
        return query
    }

    /// The query that creates the item. It is readable after the first unlock, so the Share Extension and
    /// background launches can read it.
    func newItemQuery(data: Data) -> [String: Any] {
        var query = itemQuery()
        query[kSecValueData as String] = data
        query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock as Any
        return query
    }

    public func load() throws -> Credentials? {
        var query = itemQuery()
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne as Any
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else {
            throw KeychainError(status: status)
        }
        return try JSONDecoder().decode(Credentials.self, from: data)
    }

    public func save(_ credentials: Credentials) throws {
        let data = try JSONEncoder().encode(credentials)
        var status = SecItemUpdate(itemQuery() as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecItemNotFound {
            status = SecItemAdd(newItemQuery(data: data) as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw KeychainError(status: status) }
    }

    public func delete() throws {
        let status = SecItemDelete(itemQuery() as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw KeychainError(status: status)
        }
    }
}
