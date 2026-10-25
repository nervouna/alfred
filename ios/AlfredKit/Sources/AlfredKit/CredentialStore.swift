import Synchronization

/// Where the app keeps its credentials between launches.
public protocol CredentialStore: Sendable {
    func load() throws -> Credentials?
    func save(_ credentials: Credentials) throws
    func delete() throws
}

/// Credentials kept in memory, for tests and previews.
public final class InMemoryCredentialStore: CredentialStore {
    private let stored: Mutex<Credentials?>

    public init(_ credentials: Credentials? = nil) {
        stored = Mutex(credentials)
    }

    public func load() throws -> Credentials? {
        stored.withLock { $0 }
    }

    public func save(_ credentials: Credentials) throws {
        stored.withLock { $0 = credentials }
    }

    public func delete() throws {
        stored.withLock { $0 = nil }
    }
}
