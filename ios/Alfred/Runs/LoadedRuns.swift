import AlfredKit
import Foundation
import Observation

/// The runs a screen has fetched from the server, with the reason the last fetch failed.
@MainActor
@Observable
final class LoadedRuns {
    private(set) var runs: [Run] = []
    private(set) var failure: String?
    /// Whether a fetch has finished, successfully or not.
    private(set) var hasLoaded = false

    func load(using client: AlfredClient?) async {
        guard let client else {
            failure = LoadFailure.unpaired
            hasLoaded = true
            return
        }
        do {
            runs = try await client.runs()
            failure = nil
        } catch where LoadFailure.isCancellation(error) {
            return
        } catch {
            failure = LoadFailure.message(for: error)
        }
        hasLoaded = true
    }
}

/// The words for a request that did not work.
enum LoadFailure {
    static let unpaired = "尚未配对"

    static func message(for error: any Error) -> String {
        switch error {
        case AlfredError.unauthorized: "这台设备已被撤销，请重新配对"
        case AlfredError.forbidden: "Cloudflare Access 拒绝了请求"
        case let AlfredError.http(status, message): "服务器返回 \(status)" + (message.map { "：\($0)" } ?? "")
        default: error.localizedDescription
        }
    }

    /// A request cut short because its screen went away: not a failure to show.
    static func isCancellation(_ error: any Error) -> Bool {
        error is CancellationError || (error as? URLError)?.code == .cancelled
    }
}
