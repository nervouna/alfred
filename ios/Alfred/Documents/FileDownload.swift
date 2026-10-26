import AlfredKit
import Foundation
import Observation

/// The files fetched from the workspace for a viewer. `AlfredClient.file(path:version:)` saves each to a folder of its
/// own under the temporary directory; the download removes the folders it made when it goes away.
///
/// A file at a version never changes, so it is fetched once and kept by path and version: two versions of one path never
/// share a file, and a version the viewer comes back to is not fetched again. A file without a version is the live one,
/// which may have changed, so it is fetched every time it is asked for and replaces the one before it.
@MainActor
@Observable
final class FileDownload {
    /// A file as it is asked for: its workspace path, and the version of it (`nil` for the file as it is now).
    struct Key: Hashable {
        let path: String
        let version: String?
    }

    enum State: Equatable {
        case loading
        case loaded(URL)
        /// Why the download failed.
        case failed(String)
    }

    private(set) var state = State.loading
    /// The file `state` is about.
    private(set) var key: Key?
    @ObservationIgnored private var files: [Key: URL] = [:]

    init() {}

    /// The downloaded file, once `state` is loaded.
    var loadedURL: URL? {
        if case let .loaded(url) = state { url } else { nil }
    }

    /// Makes the file `state`, unless it already is: a screen that comes back does not fetch again.
    func ensureLoaded(path: String, version: String? = nil, using client: AlfredClient?) async {
        if key == Key(path: path, version: version), case .loaded = state { return }
        await load(path: path, version: version, using: client)
    }

    /// Makes the file `state`, fetching it unless it is a version this download already holds.
    func load(path: String, version: String? = nil, using client: AlfredClient?) async {
        let wanted = Key(path: path, version: version)
        key = wanted
        state = .loading
        do {
            let url = try await file(path: path, version: version, using: client)
            // A newer request replaced this one while the file was on its way.
            guard key == wanted else { return }
            state = .loaded(url)
        } catch where LoadFailure.isCancellation(error) {
            // The screen went away. It loads again when it comes back.
            return
        } catch {
            guard key == wanted else { return }
            state = .failed(LoadFailure.message(for: error))
        }
    }

    /// The file at a path and version, on disk. It does not change `state`: a viewer uses it for the version it compares with.
    func file(path: String, version: String? = nil, using client: AlfredClient?) async throws -> URL {
        let wanted = Key(path: path, version: version)
        if version != nil, let held = files[wanted], FileManager.default.fileExists(atPath: held.path) {
            return held
        }
        guard let client else { throw NoClient() }
        let url = try await client.file(path: path, version: version)
        if version != nil, let held = files[wanted], FileManager.default.fileExists(atPath: held.path) {
            // The same version arrived twice at once; keep the first.
            remove(folderOf: url)
            return held
        }
        if let replaced = files[wanted] {
            remove(folderOf: replaced)
        }
        files[wanted] = url
        return url
    }

    private struct NoClient: LocalizedError {
        var errorDescription: String? { LoadFailure.unpaired }
    }

    private func remove(folderOf file: URL) {
        try? FileManager.default.removeItem(at: file.deletingLastPathComponent())
    }

    isolated deinit {
        for url in files.values {
            remove(folderOf: url)
        }
    }
}
