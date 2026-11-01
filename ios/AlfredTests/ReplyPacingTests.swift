import XCTest

@testable import Alfred

final class ReplyPacingTests: XCTestCase {
    private let start = Date(timeIntervalSinceReferenceDate: 1000)

    private func key(_ index: Int, run: String = "cccccc") -> ReplyPacing.Key {
        ReplyPacing.Key(runId: run, index: index)
    }

    func testPartsThatArriveTogetherShowOneAfterAnother() {
        var pacing = ReplyPacing()
        pacing.follow("cccccc", existing: [])
        for index in 0..<3 { pacing.see(key(index), length: 10, now: start) }

        let gap = ReplyPacing.typingTime(10)
        XCTAssertTrue(pacing.shows(key(0), at: start))
        XCTAssertFalse(pacing.shows(key(1), at: start))
        XCTAssertTrue(pacing.isWaiting(at: start))
        XCTAssertEqual(pacing.nextShow(after: start), start.addingTimeInterval(gap))
        XCTAssertTrue(pacing.shows(key(1), at: start.addingTimeInterval(gap)))
        XCTAssertFalse(pacing.shows(key(2), at: start.addingTimeInterval(gap)))
        XCTAssertTrue(pacing.shows(key(2), at: start.addingTimeInterval(2 * gap)))
        XCTAssertFalse(pacing.isWaiting(at: start.addingTimeInterval(2 * gap)))
    }

    func testAPartThatArrivesLateShowsWhenItArrives() {
        var pacing = ReplyPacing()
        pacing.follow("cccccc", existing: [])
        pacing.see(key(0), length: 10, now: start)
        let later = start.addingTimeInterval(30)
        pacing.see(key(1), length: 10, now: later)
        XCTAssertTrue(pacing.shows(key(1), at: later))
    }

    func testABubbleSeenAgainKeepsItsTime() {
        var pacing = ReplyPacing()
        pacing.follow("cccccc", existing: [])
        pacing.see(key(0), length: 10, now: start)
        pacing.see(key(0), length: 10, now: start.addingTimeInterval(5))
        XCTAssertTrue(pacing.shows(key(0), at: start))
    }

    func testAnUnseenBubbleOfAFollowedRunWaits() {
        var pacing = ReplyPacing()
        pacing.follow("cccccc", existing: [])
        XCTAssertFalse(pacing.shows(key(0), at: start))
    }

    func testTheBubblesARunHadWhenFollowedAndOtherRunsShowAtOnce() {
        var pacing = ReplyPacing()
        pacing.follow("cccccc", existing: [key(0)])
        XCTAssertTrue(pacing.shows(key(0), at: start))
        XCTAssertTrue(pacing.shows(key(0, run: "dddddd"), at: start))
        XCTAssertFalse(pacing.isWaiting(at: start))
    }
}
