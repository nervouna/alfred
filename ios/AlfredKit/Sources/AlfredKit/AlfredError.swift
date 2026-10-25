/// What an app API call can fail with. A transport failure passes through as the `URLError` it is.
public enum AlfredError: Error, Hashable, Sendable {
    /// 401: the device token is not accepted, so the app should offer to pair again.
    case unauthorized
    /// 403: Cloudflare Access refused the service token.
    case forbidden
    /// Any other response the call does not expect. `message` is the `ErrorResponse` text when the body has one.
    case http(status: Int, message: String?)
}
