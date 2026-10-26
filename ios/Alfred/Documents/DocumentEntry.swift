import AlfredKit
import Foundation

/// A file Alfred delivered or wrote, as the 文档 list shows it.
struct DocumentEntry: Identifiable, Hashable {
    /// Relative to the workspace.
    let path: String
    /// When Alfred delivered or finished writing it, the latest time it is known by.
    let date: Date

    var id: String { path }

    var name: String {
        path.split(separator: "/", omittingEmptySubsequences: false).last.map(String.init) ?? path
    }

    /// The folder it is in, relative to the workspace; empty for a file at the top.
    var folder: String {
        guard let slash = path.lastIndex(of: "/") else { return "" }
        return String(path[..<slash])
    }
}

enum DocumentList {
    /// The files of Alfred's outbound messages and of the runs the app knows, once per path, dated by the latest
    /// time one of them names it, newest first. A run's files are dated by when the run ended, or started while it
    /// is still going, because the server does not say when each was written.
    static func entries(timeline: Timeline, loadedRuns: [Run]) -> [DocumentEntry] {
        var newest: [String: Date] = [:]
        func note(_ path: String, at date: Date) {
            if let known = newest[path], known >= date { return }
            newest[path] = date
        }
        for message in timeline.messages where message.direction == .outbound {
            for file in message.files {
                note(file.path, at: message.at)
            }
        }
        for run in RunPresentation.merged(loaded: loadedRuns, timeline: timeline) {
            for file in run.files {
                note(file.path, at: run.endedAt ?? run.startedAt)
            }
        }
        return newest
            .map { DocumentEntry(path: $0.key, date: $0.value) }
            .sorted { $0.date != $1.date ? $0.date > $1.date : $0.path < $1.path }
    }
}
