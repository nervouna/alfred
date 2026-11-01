import Foundation

/// When each bubble of a reply Alfred is sending shows, so that the parts of one reply come one after another, as a
/// person sends them, and not all at once: the model writes the last parts in a moment, and they land together.
///
/// A bubble is a part of a run's reply, by its place among the run's outbound messages: the draft's part `i` and the
/// stored message that later takes its place share a key. Only runs the chat saw Alfred typing in are paced; the
/// bubbles a run already had then, and every bubble of any other run (a replay, a backlog), show at once.
struct ReplyPacing {
    struct Key: Hashable {
        let runId: String
        let index: Int
    }

    private var runs: Set<String> = []
    private var showAt: [Key: Date] = [:]
    /// When the latest scheduled bubble of each run shows.
    private var latest: [String: Date] = [:]
    /// The text of each draft part seen, kept after the draft goes: the first stored message of a reply takes the draft
    /// away, and the parts after it would otherwise leave the screen until their own messages land.
    private var drafts: [Key: String] = [:]

    /// Starts pacing a run's new bubbles. `existing` are the bubbles it has now, which show at once.
    mutating func follow(_ runId: String, existing: [Key]) {
        guard runs.insert(runId).inserted else { return }
        for key in existing { showAt[key] = .distantPast }
    }

    /// Schedules a bubble the first time it is seen: when it arrives, but no sooner than the time it takes to type it
    /// after the run's bubble before. Bubbles of a run are seen in order. Returns whether it was scheduled to show at once.
    @discardableResult
    mutating func see(_ key: Key, length: @autoclosure () -> Int, now: Date) -> Bool {
        guard runs.contains(key.runId), showAt[key] == nil else { return false }
        let earliest = latest[key.runId].map { $0.addingTimeInterval(Self.typingTime(length())) } ?? now
        let at = max(now, earliest)
        showAt[key] = at
        latest[key.runId] = at
        return at <= now
    }

    /// Keeps the text of a draft part: the latest draft's, when a new stream writes the part again.
    mutating func remember(_ key: Key, text: String) {
        guard runs.contains(key.runId) else { return }
        drafts[key] = text
    }

    /// The text a draft part had when it was last seen.
    func draftText(_ key: Key) -> String? {
        drafts[key]
    }

    /// Whether a bubble shows at `now`. A bubble of a paced run that has not been seen yet waits.
    func shows(_ key: Key, at now: Date) -> Bool {
        guard runs.contains(key.runId) else { return true }
        guard let at = showAt[key] else { return false }
        return at <= now
    }

    /// Whether a bubble is waiting to show: Alfred is still typing it.
    func isWaiting(at now: Date) -> Bool {
        showAt.values.contains { $0 > now }
    }

    /// When the next waiting bubble shows.
    func nextShow(after now: Date) -> Date? {
        showAt.values.filter { $0 > now }.min()
    }

    /// How long a bubble of `length` characters takes to type, kept between a short pause and a few seconds.
    static func typingTime(_ length: Int) -> TimeInterval {
        min(2.5, max(0.8, 0.5 + Double(length) * 0.03))
    }
}
