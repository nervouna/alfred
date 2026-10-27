import Foundation

/// What Alfred is doing in the chat: waiting for the owner, or working on a chat run.
enum AvatarState: Equatable {
    case standingBy
    case working

    /// `working` while a chat run runs (`AppModel.runningChatRun != nil`).
    init(isWorking: Bool) {
        self = isWorking ? .working : .standingBy
    }
}

/// One short video of the butler. The idle clips (`blink`, `smile`, `yawn`) start and end on the resting pose;
/// `workStart` goes from it to the typing pose, `workLoop` starts and ends on the typing pose, and `workEnd` goes back.
enum AvatarClip: CaseIterable, Equatable {
    case blink, smile, yawn, workStart, workLoop, workEnd

    /// The name of the clip's file in the bundle, without the `.mp4`.
    var resourceName: String {
        switch self {
        case .blink: "blink"
        case .smile: "smile"
        case .yawn: "yawn"
        case .workStart: "work-start"
        case .workLoop: "work-loop"
        case .workEnd: "work-end"
        }
    }
}

/// Seconds on a steady scale. The director only compares readings of it and adds pauses to them.
protocol AvatarClock {
    var now: TimeInterval { get }
}

/// Time since the device started: it does not jump when the owner changes the date.
struct SystemAvatarClock: AvatarClock {
    var now: TimeInterval { ProcessInfo.processInfo.systemUptime }
}

/// Decides which clip plays next. It knows nothing of video: whoever plays the clips asks it for the first cue, tells it
/// when the state changes or the clip in progress ends, and plays what it answers.
///
/// - Standing by, it cues one of `blink`, `smile` or `yawn` after a pause, again and again, never the same clip twice in
///   a row.
/// - When the state turns to `working`, a clip in progress finishes and `workStart` follows; in a pause `workStart`
///   comes at once. Then `workLoop` repeats for as long as the state is `working`.
/// - When it turns back to `standingBy`, the pass of `workLoop` (or `workStart`) in progress finishes, then `workEnd`
///   plays and the idle cycle starts again. If the state turns to `working` again while `workEnd` plays, `workEnd`
///   finishes and `workStart` follows.
/// - With Reduce Motion on there are no clips at all.
struct AvatarDirector {
    /// A clip to play and when to start it, on the director's clock. Idle clips start after a pause; the others at once.
    struct Cue: Equatable {
        let clip: AvatarClip
        let at: TimeInterval
    }

    /// How long Alfred stands still between idle clips, in seconds.
    static let pauses: ClosedRange<TimeInterval> = 8...20

    private enum Phase {
        /// Nothing is cued: before `start()`, or with Reduce Motion on.
        case stopped
        /// A clip is cued. It is waiting while the clock is before `at`, and in progress from then until `clipEnded()`.
        case cued(Cue)
    }

    private(set) var state: AvatarState
    private(set) var reduceMotion: Bool
    private var phase = Phase.stopped
    private var random: AvatarRandom
    private let clock: any AvatarClock

    init(state: AvatarState, reduceMotion: Bool = false, random: some RandomNumberGenerator, clock: any AvatarClock) {
        self.state = state
        self.reduceMotion = reduceMotion
        self.random = AvatarRandom(random)
        self.clock = clock
    }

    // MARK: Events

    /// The first cue. `nil` with Reduce Motion on.
    mutating func start() -> Cue? {
        guard !reduceMotion else { return nil }
        return cue(state == .working ? .workStart : nil)
    }

    /// The state changed. Returns a cue that replaces the one being waited for (a `workStart` that does not wait for the
    /// pause), or `nil` when the clip in progress, if there is one, goes on and decides what follows.
    mutating func update(state newState: AvatarState) -> Cue? {
        guard newState != state else { return nil }
        state = newState
        guard !reduceMotion, case let .cued(current) = phase, clock.now < current.at else { return nil }
        // Only an idle clip waits, and only while standing by.
        return newState == .working ? cue(.workStart) : nil
    }

    /// Reduce Motion changed. Turning it on cancels what is cued, and the clip in progress is the caller's to stop.
    /// Turning it off starts the cycle again from the current state.
    mutating func update(reduceMotion newValue: Bool) -> Cue? {
        guard newValue != reduceMotion else { return nil }
        reduceMotion = newValue
        if newValue {
            phase = .stopped
            return nil
        }
        return start()
    }

    /// The clip in progress ended. Returns what to play next.
    mutating func clipEnded() -> Cue? {
        guard !reduceMotion, case let .cued(current) = phase, clock.now >= current.at else { return nil }
        switch (current.clip, state) {
        case (.workStart, .working), (.workLoop, .working): return cue(.workLoop)
        case (.workStart, .standingBy), (.workLoop, .standingBy): return cue(.workEnd)
        // An idle clip or `workEnd` ended: they all end on the resting pose.
        case (_, .working): return cue(.workStart)
        case (_, .standingBy): return cue(nil)
        }
    }

    // MARK: Drawing

    /// Cues `clip` at once, or, with `nil`, draws an idle clip and cues it after a pause.
    private mutating func cue(_ clip: AvatarClip?) -> Cue {
        let next: Cue
        if let clip {
            next = Cue(clip: clip, at: clock.now)
        } else {
            var last: AvatarClip?
            if case let .cued(current) = phase { last = current.clip }
            let pause = TimeInterval.random(in: Self.pauses, using: &random)
            next = Cue(clip: Self.idleClip(excluding: last, using: &random), at: clock.now + pause)
        }
        phase = .cued(next)
        return next
    }

    /// Draws an idle clip: `blink` three times in five, `smile` and `yawn` one in five each. The clip `excluding` names
    /// (the one that played last) is left out, and the others keep their weights.
    static func idleClip(excluding last: AvatarClip?, using generator: inout some RandomNumberGenerator) -> AvatarClip {
        let weights: [(clip: AvatarClip, weight: Int)] = [(.blink, 3), (.smile, 1), (.yawn, 1)].filter { $0.0 != last }
        var draw = Int.random(in: 0..<weights.reduce(0) { $0 + $1.weight }, using: &generator)
        for (clip, weight) in weights {
            if draw < weight { return clip }
            draw -= weight
        }
        return .blink
    }
}

/// Any random source behind one concrete type, so that the director can be a plain value.
private struct AvatarRandom: RandomNumberGenerator {
    private var base: any RandomNumberGenerator

    init(_ base: some RandomNumberGenerator) {
        self.base = base
    }

    mutating func next() -> UInt64 {
        base.next()
    }
}
