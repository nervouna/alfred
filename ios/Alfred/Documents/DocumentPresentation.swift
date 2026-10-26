import AlfredKit
import Foundation

/// How documents read in the app: a workspace path's name and folder, the words for what made a version, the number and
/// the line of a version in the 版本 list, the banner over an old version, and where a file of a message opens.
enum DocumentPresentation {
    /// The name of the file a workspace path names.
    static func name(of path: String) -> String {
        path.split(separator: "/", omittingEmptySubsequences: false).last.map(String.init) ?? path
    }

    /// The folder a workspace path is in, relative to the workspace; empty for a file at the top.
    static func folder(of path: String) -> String {
        guard let slash = path.lastIndex(of: "/") else { return "" }
        return String(path[..<slash])
    }

    /// What made a version. A reason this app does not know shows as the server wrote it.
    static func reasonLabel(_ reason: DocumentVersionReason) -> String {
        switch reason {
        case .delivered: "交付"
        case .revised: "修订"
        case .undone: "撤销"
        case .changed: "修改"
        default: reason.rawValue
        }
    }

    // MARK: Versions

    /// The number of a version: the first one is 1. `versions` is the document's list, newest first. `nil` when the list
    /// does not hold the version.
    static func number(of version: String, in versions: [DocumentVersion]) -> Int? {
        versions.firstIndex { $0.version == version }.map { versions.count - $0 }
    }

    /// The version before this one, the one a Markdown version is compared with: `nil` for the first version and for a
    /// version the list does not hold.
    static func previous(of version: String, in versions: [DocumentVersion]) -> String? {
        guard let index = versions.firstIndex(where: { $0.version == version }), index + 1 < versions.count else { return nil }
        return versions[index + 1].version
    }

    /// A version in the 版本 list.
    struct VersionRow: Equatable, Identifiable {
        let version: String
        /// 1 for the first version.
        let number: Int
        let isCurrent: Bool
        /// What made it: 交付, 修订, 撤销 or 修改.
        let reason: String
        let at: Date
        let runId: String?

        var id: String { version }

        /// `第 3 版`.
        var title: String { "第 \(number) 版" }
    }

    /// The rows of the 版本 list, newest first as `versions` is. The first of them is the current version.
    static func rows(of versions: [DocumentVersion]) -> [VersionRow] {
        versions.enumerated().map { index, version in
            VersionRow(
                version: version.version,
                number: versions.count - index,
                isCurrent: index == 0,
                reason: reasonLabel(version.reason),
                at: version.at,
                runId: version.runId
            )
        }
    }

    // MARK: The banner

    /// The banner over a version that is not the current one: what it says, and the button back to the current version.
    struct Banner: Equatable {
        let title: String
        let detail: String?
        /// The button that opens the current version.
        let action: String
    }

    /// The banner for the version on screen. `shown` is the version the owner or a message chose, `nil` for the current one;
    /// nothing shows while the current version is on screen. A version a message delivered says a newer one exists; a
    /// version the owner picked from the list says which version it is.
    static func banner(shown: String?, current: String, fromMessage: Bool, versions: [DocumentVersion]) -> Banner? {
        guard let shown, shown != current else { return nil }
        let number = number(of: shown, in: versions)
        if fromMessage {
            return Banner(
                title: "有更新的版本",
                detail: number.map { "这条消息交付的是第 \($0) 版" },
                action: "查看最新版本"
            )
        }
        let version = versions.first { $0.version == shown }
        let which = number.map { "第 \($0) 版" } ?? "旧版本"
        let title = version.map { "正在查看\(which)（\(reasonLabel($0.reason))）" } ?? "正在查看\(which)"
        let when = version.map { " · " + RunPresentation.dateTime($0.at) } ?? ""
        return Banner(title: title, detail: "只读" + when, action: "回到当前版本")
    }

    // MARK: Files

    /// Where a file chip of a message opens.
    enum FileTarget: Equatable {
        /// A file with no document, as an older message or an upload has: the viewer, on the live file.
        case file(path: String)
        /// A document's screen, at the version the message delivered (`nil` for its current one).
        case document(id: String, version: String?)

        /// An outbound message's file that names a document opens that document; any other file opens the viewer.
        init(file: FileRef, in message: Message) {
            if message.direction == .outbound, let documentId = file.documentId {
                self = .document(id: documentId, version: file.version)
            } else {
                self = .file(path: file.path)
            }
        }
    }
}
