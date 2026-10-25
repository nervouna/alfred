import Foundation

/// The shared fixtures under fixtures/api/, located relative to this source file.
enum Fixtures {
    static let directory: URL = {
        var url = URL(fileURLWithPath: #filePath)
        // Fixtures.swift -> Tests/AlfredKitTests -> Tests -> AlfredKit -> ios -> repository root.
        for _ in 0..<5 { url.deleteLastPathComponent() }
        return url.appending(path: "fixtures/api", directoryHint: .isDirectory)
    }()

    /// The JSON files in one fixture directory, sorted by name.
    static func jsonFiles(in name: String) throws -> [URL] {
        let urls = try FileManager.default.contentsOfDirectory(
            at: directory.appending(path: name, directoryHint: .isDirectory),
            includingPropertiesForKeys: nil
        )
        return urls
            .filter { $0.pathExtension == "json" }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
    }
}
