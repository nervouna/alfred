import Foundation
import Observation

/// The ids of the ideas the owner has seen: an open idea is seen once the 想法 tab has been on screen with the app in the
/// foreground while it was there. They are kept on the phone, in `UserDefaults`, and nowhere else. Without defaults (a
/// model made for a test) they are only in memory.
@MainActor
@Observable
final class SeenIdeas {
    private static let key = "alfred.seenIdeaIds"

    private(set) var ids: Set<String>
    @ObservationIgnored private let defaults: UserDefaults?

    init(defaults: UserDefaults? = nil) {
        self.defaults = defaults
        ids = Set(defaults?.stringArray(forKey: Self.key) ?? [])
    }

    func contains(_ id: String) -> Bool {
        ids.contains(id)
    }

    func markSeen(_ newIds: some Sequence<String>) {
        let union = ids.union(newIds)
        guard union != ids else { return }
        change(to: union)
    }

    /// Forgets the ids that are not in `known`: the ideas the server no longer holds.
    func prune(keeping known: Set<String>) {
        let kept = ids.intersection(known)
        guard kept != ids else { return }
        change(to: kept)
    }

    /// Forgets everything: the pairing is gone.
    func clear() {
        guard !ids.isEmpty || defaults?.object(forKey: Self.key) != nil else { return }
        ids = []
        defaults?.removeObject(forKey: Self.key)
    }

    private func change(to next: Set<String>) {
        ids = next
        defaults?.set(next.sorted(), forKey: Self.key)
    }
}
