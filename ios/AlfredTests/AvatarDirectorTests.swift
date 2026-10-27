import XCTest

@testable import Alfred

/// The director on a seeded random source and a clock the test moves. `Stage` plays it the way the avatar does: it waits
/// for the cue, lets the clip run for two seconds, and reports that the clip ended.
final class AvatarDirectorTests: XCTestCase {
    private typealias Cue = AvatarDirector.Cue
    private let idleClips: Set<AvatarClip> = [.blink, .smile, .yawn]

    // MARK: Standing by

    func testStandingByGivesOnlyIdleClipsAfterAPauseOfEightToTwentySeconds() {
        var stage = Stage(.standingBy)
        var pauses: [TimeInterval] = []
        for _ in 0..<200 {
            let played = stage.playPending()
            XCTAssertTrue(idleClips.contains(played.clip), "\(played.clip) is not an idle clip")
            pauses.append(played.pause)
            stage.finishClip()
        }
        XCTAssertTrue(pauses.allSatisfy { (8...20).contains($0) }, "a pause is outside 8 to 20 seconds: \(pauses.min() ?? 0) to \(pauses.max() ?? 0)")
        XCTAssertGreaterThan(pauses.max() ?? 0, 18, "the pauses should use the whole range")
        XCTAssertLessThan(pauses.min() ?? 99, 10, "the pauses should use the whole range")
    }

    func testNoClipRepeatsBackToBack() {
        var stage = Stage(.standingBy, seed: 7)
        var previous: AvatarClip?
        for _ in 0..<1_000 {
            let played = stage.playPending().clip
            XCTAssertNotEqual(played, previous)
            previous = played
            stage.finishClip()
        }
    }

    func testEachDrawFollowsTheWeightsThreeToOneToOne() {
        var random = SeededRandom(seed: 11)
        var counts: [AvatarClip: Int] = [:]
        for _ in 0..<1_000 {
            counts[AvatarDirector.idleClip(excluding: nil, using: &random), default: 0] += 1
        }
        XCTAssertEqual(Set(counts.keys), idleClips)
        // 3:1:1 is 600, 200 and 200 of 1,000.
        XCTAssertEqual(Double(counts[.blink] ?? 0), 600, accuracy: 70)
        XCTAssertEqual(Double(counts[.smile] ?? 0), 200, accuracy: 60)
        XCTAssertEqual(Double(counts[.yawn] ?? 0), 200, accuracy: 60)
    }

    func testTheClipThatJustPlayedIsLeftOutAndTheOthersKeepTheirWeights() {
        var random = SeededRandom(seed: 5)
        var afterSmile: [AvatarClip: Int] = [:]
        var afterBlink: [AvatarClip: Int] = [:]
        for _ in 0..<1_000 {
            afterSmile[AvatarDirector.idleClip(excluding: .smile, using: &random), default: 0] += 1
            afterBlink[AvatarDirector.idleClip(excluding: .blink, using: &random), default: 0] += 1
        }
        XCTAssertNil(afterSmile[.smile])
        XCTAssertEqual(Double(afterSmile[.blink] ?? 0), 750, accuracy: 60, "blink against yawn is 3 to 1")
        XCTAssertNil(afterBlink[.blink])
        XCTAssertEqual(Double(afterBlink[.smile] ?? 0), 500, accuracy: 60, "smile against yawn is 1 to 1")
    }

    // MARK: Standing by to working

    func testWorkingStartsAtOnceWhenNoClipIsPlayingThenLoops() {
        var stage = Stage(.standingBy)
        // The pause has not run out: nothing is playing.
        stage.clock.now += 1
        stage.set(.working)
        XCTAssertEqual(stage.cue?.clip, .workStart)
        XCTAssertEqual(stage.cue?.at, stage.clock.now, "workStart does not wait for the pause")

        XCTAssertEqual(stage.playPending().clip, .workStart)
        stage.finishClip()
        for _ in 0..<5 {
            XCTAssertEqual(stage.playPending().clip, .workLoop)
            stage.finishClip()
        }
    }

    func testTheClipInProgressFinishesBeforeWorkStarts() {
        var stage = Stage(.standingBy)
        let played = stage.playPending().clip
        XCTAssertTrue(idleClips.contains(played))

        stage.set(.working)
        XCTAssertNil(stage.cue, "the clip in progress is not cut off")
        stage.finishClip()
        XCTAssertEqual(stage.cue?.clip, .workStart)
        XCTAssertEqual(stage.cue?.at, stage.clock.now, "workStart follows at once")
    }

    func testAWorkingDirectorStartsWithWorkStart() {
        var stage = Stage(.working)
        XCTAssertEqual(stage.playPending().clip, .workStart)
        stage.finishClip()
        XCTAssertEqual(stage.playPending().clip, .workLoop)
    }

    // MARK: Working to standing by

    func testTheCurrentLoopPassFinishesThenWorkEndThenTheIdleCycleStartsAgain() {
        var stage = Stage(.working)
        _ = stage.playPending()
        stage.finishClip()
        XCTAssertEqual(stage.playPending().clip, .workLoop)

        stage.set(.standingBy)
        XCTAssertNil(stage.cue, "the pass in progress is not cut off")
        stage.finishClip()
        XCTAssertEqual(stage.playPending().clip, .workEnd)
        stage.finishClip()

        let idle = stage.playPending()
        XCTAssertTrue(idleClips.contains(idle.clip))
        XCTAssertTrue((8...20).contains(idle.pause), "the idle cycle starts with a pause: \(idle.pause)")
    }

    func testAFlipDuringWorkStartGoesStraightToWorkEnd() {
        var stage = Stage(.working)
        XCTAssertEqual(stage.playPending().clip, .workStart)
        stage.set(.standingBy)
        stage.finishClip()
        XCTAssertEqual(stage.playPending().clip, .workEnd, "workStart ends on the typing pose, which workEnd starts on")
    }

    func testAFlipBackToWorkingDuringWorkEndFinishesItThenStartsWork() {
        var stage = Stage(.working)
        _ = stage.playPending()
        stage.finishClip()
        _ = stage.playPending()
        stage.set(.standingBy)
        stage.finishClip()
        XCTAssertEqual(stage.playPending().clip, .workEnd)

        stage.set(.working)
        XCTAssertNil(stage.cue, "workEnd is not cut off")
        stage.finishClip()
        XCTAssertEqual(stage.playPending().clip, .workStart)
        stage.finishClip()
        XCTAssertEqual(stage.playPending().clip, .workLoop)
    }

    func testAFlipAndBackDuringALoopPassKeepsLooping() {
        var stage = Stage(.working)
        _ = stage.playPending()
        stage.finishClip()
        _ = stage.playPending()
        stage.set(.standingBy)
        stage.set(.working)
        stage.finishClip()
        XCTAssertEqual(stage.playPending().clip, .workLoop)
    }

    // MARK: Reduce Motion

    func testReduceMotionGivesNoClipAtAll() {
        var stage = Stage(.standingBy, reduceMotion: true)
        XCTAssertNil(stage.cue)
        stage.set(.working)
        XCTAssertNil(stage.cue)
        XCTAssertNil(stage.director.clipEnded())
        stage.set(.standingBy)
        XCTAssertNil(stage.cue)
        XCTAssertNil(stage.director.clipEnded())
    }

    func testSwitchingReduceMotionOnStopsTheClipsAndOffStartsTheCycleAgain() {
        var stage = Stage(.standingBy)
        XCTAssertNotNil(stage.cue)

        stage.setReduceMotion(true)
        XCTAssertNil(stage.cue)
        XCTAssertNil(stage.director.clipEnded(), "the clip that was in progress does not go on")

        stage.setReduceMotion(false)
        let played = stage.playPending()
        XCTAssertTrue(idleClips.contains(played.clip))
        XCTAssertTrue((8...20).contains(played.pause))

        stage.setReduceMotion(true)
        stage.set(.working)
        stage.setReduceMotion(false)
        XCTAssertEqual(stage.cue?.clip, .workStart, "it picks up the state it missed")
    }

    // MARK: Names

    func testClipsAreNamedLikeTheirFiles() {
        XCTAssertEqual(AvatarClip.allCases.map(\.resourceName), ["blink", "smile", "yawn", "work-start", "work-loop", "work-end"])
    }

    func testOnlyAWorkingChatRunMakesAlfredWork() {
        XCTAssertEqual(AvatarState(isWorking: true), .working)
        XCTAssertEqual(AvatarState(isWorking: false), .standingBy)
    }
}

// MARK: Test support

/// A clock the test moves.
private final class FakeClock: AvatarClock {
    var now: TimeInterval = 1_000
}

/// SplitMix64: the same seed gives the same draws.
private struct SeededRandom: RandomNumberGenerator {
    private var state: UInt64

    init(seed: UInt64) {
        state = seed
    }

    mutating func next() -> UInt64 {
        state &+= 0x9E37_79B9_7F4A_7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
        z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
        return z ^ (z >> 31)
    }
}

/// A director on a fake clock, run the way the avatar runs it. A clip lasts two seconds.
private struct Stage {
    static let clipLength: TimeInterval = 2

    let clock = FakeClock()
    var director: AvatarDirector
    /// The cue the avatar is waiting for, or has just been given.
    var cue: AvatarDirector.Cue?

    init(_ state: AvatarState, reduceMotion: Bool = false, seed: UInt64 = 1) {
        director = AvatarDirector(state: state, reduceMotion: reduceMotion, random: SeededRandom(seed: seed), clock: clock)
        cue = director.start()
    }

    /// Waits out the pending cue's pause and starts its clip. Returns the clip and how long the avatar waited.
    mutating func playPending() -> (clip: AvatarClip, pause: TimeInterval) {
        guard let cue else {
            XCTFail("no clip is cued")
            return (.blink, 0)
        }
        let pause = cue.at - clock.now
        clock.now = max(clock.now, cue.at)
        self.cue = nil
        return (cue.clip, pause)
    }

    /// The clip in progress ends.
    mutating func finishClip() {
        clock.now += Self.clipLength
        cue = director.clipEnded()
    }

    /// The state changes. A cue the director gives replaces the pending one.
    mutating func set(_ state: AvatarState) {
        if let replacement = director.update(state: state) {
            cue = replacement
        }
    }

    mutating func setReduceMotion(_ reduceMotion: Bool) {
        cue = director.update(reduceMotion: reduceMotion)
    }
}
