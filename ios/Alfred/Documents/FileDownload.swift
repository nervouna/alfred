import AlfredKit
import Foundation
import Observation

/// One file fetched from the workspace for a viewer. `AlfredClient.file(path:)` saves it to its own folder under
/// the temporary directory; the download removes that folder when it is replaced or goes away.
@MainActor
@Observable
final class FileDownload {
    enum State: Equatable {
        case loading
        case loaded(URL)
        /// Why the download failed.
        case failed(String)
    }

    private(set) var state = State.loading
    @ObservationIgnored private var folder: URL?

    init() {}

    func load(path: String, using client: AlfredClient?) async {
        state = .loading
        guard let client else {
            state = .failed(LoadFailure.unpaired)
            return
        }
        do {
            let url = try await client.file(path: path)
            removeFolder()
            folder = url.deletingLastPathComponent()
            state = .loaded(url)
        } catch where LoadFailure.isCancellation(error) {
            // The screen went away. It loads again when it comes back.
            return
        } catch {
            state = .failed(LoadFailure.message(for: error))
        }
    }

    private func removeFolder() {
        if let folder { try? FileManager.default.removeItem(at: folder) }
        folder = nil
    }

    isolated deinit {
        removeFolder()
    }
}
