/// What the app sends to register its APNs device token with Alfred.
public struct PushRegistration: Encodable, Hashable, Sendable {
    /// The device token as lowercase hex.
    public let token: String
    public let environment: PushEnvironment

    public init(token: String, environment: PushEnvironment) {
        self.token = token
        self.environment = environment
    }
}
