import AVFoundation
import SwiftUI
import UIKit
import XCTest

@testable import Alfred

/// The avatar's fallbacks: the clip, else the picture of the pose it starts on (the still, or the typing pose), else a
/// navy circle with a person in it, and a stand-in of two seconds for a clip that cannot play. The cover over both lanes
/// holds the picture of the pose the clip starts on, and an undrawn lane is never what is on top. The files are made in a
/// folder of the test's own, except where the real clips and pictures are used.
@MainActor
final class AvatarPlayerTests: XCTestCase {
    private var folder: URL!

    override func setUpWithError() throws {
        folder = FileManager.default.temporaryDirectory.appending(path: "avatar-\(UUID().uuidString)", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: folder)
    }

    // MARK: The chain

    func testWithNoFilesTheAvatarIsThePlaceholder() async {
        let resources = AvatarResources(folders: [folder])
        for clip in AvatarClip.allCases {
            XCTAssertNil(resources.clipURL(for: clip))
            let picture = await resources.picture(for: clip)
            XCTAssertEqual(picture, .placeholder, "\(clip) with no files")
        }
        XCTAssertEqual(resources.restingPicture(), .placeholder)
    }

    func testWithoutAClipTheStillShows() async throws {
        try writeStill()
        let resources = AvatarResources(folders: [folder])
        for clip in AvatarClip.allCases {
            let picture = await resources.picture(for: clip)
            guard case .still = picture else { return XCTFail("\(clip) without a file shows \(picture), not the still") }
        }
    }

    func testAClipThatCannotBeReadFallsBackToTheStill() async throws {
        try writeStill()
        try Data().write(to: folder.appending(path: "blink.mp4"))
        try Data("this is not a video".utf8).write(to: folder.appending(path: "work-loop.mp4"))
        let resources = AvatarResources(folders: [folder])
        XCTAssertNotNil(resources.clipURL(for: .blink), "the files are there")
        for clip in [AvatarClip.blink, .workLoop] {
            let picture = await resources.picture(for: clip)
            guard case .still = picture else { return XCTFail("\(clip) is unreadable and shows \(picture), not the still") }
        }
    }

    func testAClipThatCannotBeReadWithoutAStillFallsBackToThePlaceholder() async throws {
        try Data("this is not a video".utf8).write(to: folder.appending(path: "smile.mp4"))
        let picture = await AvatarResources(folders: [folder]).picture(for: .smile)
        XCTAssertEqual(picture, .placeholder)
    }

    func testAStillThatIsNotAnImageIsNotTheStill() {
        XCTAssertNoThrow(try Data("nope".utf8).write(to: folder.appending(path: "still.png")))
        XCTAssertEqual(AvatarResources(folders: [folder]).restingPicture(), .placeholder)
    }

    func testAPlayableClipIsTheClip() async throws {
        try writeStill()
        let url = folder.appending(path: "work-start.mp4")
        try await writeClip(to: url)
        let resources = AvatarResources(folders: [folder])
        let picture = await resources.picture(for: .workStart)
        XCTAssertEqual(picture, .clip(url))
        let other = await resources.picture(for: .workEnd)
        guard case .still = other else { return XCTFail("a clip without a file still shows the still") }
    }

    func testEveryClipIsLookedUpByItsFileName() throws {
        for clip in AvatarClip.allCases {
            try Data().write(to: folder.appending(path: clip.resourceName + ".mp4"))
        }
        let resources = AvatarResources(folders: [folder])
        XCTAssertEqual(
            AvatarClip.allCases.compactMap { resources.clipURL(for: $0)?.lastPathComponent },
            ["blink.mp4", "smile.mp4", "yawn.mp4", "work-start.mp4", "work-loop.mp4", "work-end.mp4"]
        )
    }

    func testTheFirstFolderThatHasTheFileWins() throws {
        let other = folder.appending(path: "Clips", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: other, withIntermediateDirectories: true)
        try Data().write(to: other.appending(path: "yawn.mp4"))
        XCTAssertEqual(AvatarResources(folders: [folder, other]).clipURL(for: .yawn), other.appending(path: "yawn.mp4"))
    }

    // MARK: The player

    func testAMissingClipIsStoodInForTwoSecondsWithoutAnError() async throws {
        XCTAssertEqual(AvatarPlayer.standIn, .seconds(2))

        let player = AvatarPlayer(resources: AvatarResources(folders: [folder]), standIn: .milliseconds(150))
        let began = ContinuousClock.now
        let ended = expectation(description: "the stand-in passed")
        player.play(.blink) { ended.fulfill() }
        XCTAssertTrue(player.lanes.allSatisfy { $0.player.currentItem == nil }, "nothing plays")
        await fulfillment(of: [ended], timeout: 5)
        XCTAssertGreaterThanOrEqual(ContinuousClock.now - began, .milliseconds(150))
        XCTAssertEqual(player.cover.picture, .placeholder)
        XCTAssertTrue(player.cover.isUp, "the cover stays up for a clip that cannot play")
    }

    func testAnUnreadableClipIsStoodInForToo() async throws {
        try Data("this is not a video".utf8).write(to: folder.appending(path: "yawn.mp4"))
        let player = AvatarPlayer(resources: AvatarResources(folders: [folder]), standIn: .milliseconds(50))
        let ended = expectation(description: "the stand-in passed")
        player.play(.yawn) { ended.fulfill() }
        await fulfillment(of: [ended], timeout: 5)
        XCTAssertTrue(player.lanes.allSatisfy { $0.player.currentItem == nil })
    }

    func testAClipPlaysMutedToItsEnd() async throws {
        try await writeClip(to: folder.appending(path: "blink.mp4"), frames: 12)
        let player = AvatarPlayer(resources: AvatarResources(folders: [folder]))
        let window = try showWindow(AvatarPlayerSurface(layers: player.layers).frame(width: 180, height: 180))
        defer { window.isHidden = true }
        let ended = expectation(description: "the clip ended")
        player.play(.blink) { ended.fulfill() }
        await fulfillment(of: [ended], timeout: 10)

        XCTAssertTrue(player.lanes.allSatisfy { $0.player.isMuted })
        let item = try XCTUnwrap(player.lanes.compactMap { $0.player.currentItem }.first, "the last frame stays until something replaces it")
        XCTAssertEqual(item.currentTime().seconds, 0.5, accuracy: 0.1, "it played to the end")
        XCTAssertFalse(player.cover.isUp, "the clip played, so the cover is down")
        player.rest()
        XCTAssertTrue(player.lanes.allSatisfy { $0.player.currentItem == nil })
        XCTAssertTrue(player.cover.isUp)
    }

    func testStoppingCallsNothing() async throws {
        let player = AvatarPlayer(resources: AvatarResources(folders: [folder]), standIn: .milliseconds(100))
        let ended = expectation(description: "nothing ends")
        ended.isInverted = true
        player.play(.blink) { ended.fulfill() }
        player.stop()
        await fulfillment(of: [ended], timeout: 0.5)
    }

    func testStartingAClipEndsTheOneInProgressWithoutItsCallback() async throws {
        let player = AvatarPlayer(resources: AvatarResources(folders: [folder]), standIn: .milliseconds(100))
        let first = expectation(description: "the first clip does not end")
        first.isInverted = true
        let second = expectation(description: "the second clip ends")
        player.play(.blink) { first.fulfill() }
        player.play(.smile) { second.fulfill() }
        await fulfillment(of: [first, second], timeout: 1)
    }

    // MARK: The pictures of the poses

    func testEveryClipStartsAndEndsOnItsPose() {
        let starts: [AvatarClip: AvatarPose] = [.blink: .standing, .smile: .standing, .yawn: .standing, .workStart: .standing, .workLoop: .typing, .workEnd: .typing]
        let ends: [AvatarClip: AvatarPose] = [.blink: .standing, .smile: .standing, .yawn: .standing, .workStart: .typing, .workLoop: .typing, .workEnd: .standing]
        XCTAssertEqual(Set(starts.keys), Set(AvatarClip.allCases))
        for clip in AvatarClip.allCases {
            XCTAssertEqual(clip.startPose, starts[clip], "\(clip) starts on")
            XCTAssertEqual(clip.endPose, ends[clip], "\(clip) ends on")
        }
    }

    func testTheTypingPictureIsTypingPngAndTheStandingOneIsStillPng() throws {
        try writeStill(.red)
        try writeTyping(.blue)
        let resources = AvatarResources(folders: [folder])
        XCTAssertEqual(try look(resources.picture(of: .standing)), "still")
        XCTAssertEqual(try look(resources.picture(of: .typing)), "typing")
        XCTAssertEqual(try look(resources.restingPicture()), "still")
    }

    func testWithoutTypingPngTheTypingPictureIsTheStill() throws {
        try writeStill(.red)
        let resources = AvatarResources(folders: [folder])
        XCTAssertEqual(try look(resources.picture(of: .typing)), "still")
        try Data("this is not an image".utf8).write(to: folder.appending(path: "typing.png"))
        XCTAssertEqual(try look(resources.picture(of: .typing)), "still", "a typing.png that is not an image is no typing picture")
    }

    func testWithNeitherPictureThePosesAreThePlaceholder() throws {
        let resources = AvatarResources(folders: [folder])
        XCTAssertEqual(resources.picture(of: .typing), .placeholder)
        XCTAssertEqual(resources.picture(of: .standing), .placeholder)
        try writeTyping(.blue)
        XCTAssertEqual(resources.picture(of: .standing), .placeholder, "the typing picture does not stand in for the still")
        XCTAssertEqual(try look(resources.picture(of: .typing)), "typing")
    }

    func testAClipThatCannotPlayShowsThePictureOfThePoseItStartsOn() async throws {
        try writeStill(.red)
        try writeTyping(.blue)
        let resources = AvatarResources(folders: [folder])
        for clip in AvatarClip.allCases {
            let expected = clip.startPose == .typing ? "typing" : "still"
            let picture = await resources.picture(for: clip)
            XCTAssertEqual(try look(picture), expected, "\(clip) without a file")
        }
    }

    // MARK: The cover

    func testAtRestTheCoverIsUpWithTheStillAndNoLaneIsVisible() throws {
        try writeStill(.red)
        try writeTyping(.blue)
        let player = AvatarPlayer(resources: AvatarResources(folders: [folder]), standIn: .milliseconds(20))
        XCTAssertTrue(player.cover.isUp, "the cover is up before the first clip")
        XCTAssertEqual(try look(player.cover.picture), "still")
        XCTAssertNotNil(player.cover.layer.contents, "the cover holds a picture")
        XCTAssertEqual(player.layers.last, player.cover.layer, "the cover is the last of the layers, the one drawn on top")
        XCTAssertTrue(player.lanes.allSatisfy { !$0.isVisible }, "no lane is visible before the first clip")
        player.play(.workLoop) {}
        player.stop()
        XCTAssertTrue(player.cover.isUp)
        XCTAssertEqual(try look(player.cover.picture), "still", "a stop leaves the still under the cover")
        XCTAssertTrue(player.lanes.allSatisfy { !$0.isVisible })
    }

    func testTheCoverAlwaysHoldsAPictureAndIsAboveBothLanes() throws {
        func check(_ message: String) {
            let player = AvatarPlayer(resources: AvatarResources(folders: [folder]))
            XCTAssertNotNil(player.cover.layer.contents, message)
            XCTAssertTrue(player.lanes.allSatisfy { $0.layer.zPosition < player.cover.layer.zPosition }, message)
            XCTAssertEqual(player.cover.layer.opacity, 1, message)
        }
        check("no pictures: the placeholder")
        try writeStill()
        check("the still only")
        try writeTyping()
        check("the still and the typing pose")
    }

    /// The cover goes up with the picture of the pose each clip starts on: the still for `blink`, `smile`, `yawn` and
    /// `work-start`, the typing pose for `work-loop` and `work-end`.
    func testEachClipPutsTheCoverUpWithThePictureOfItsStartingPose() throws {
        try writeStill(.red)
        try writeTyping(.blue)
        let player = AvatarPlayer(resources: AvatarResources(folders: [folder]), standIn: .milliseconds(20))
        XCTAssertEqual(try look(player.cover.picture), "still", "at rest")
        let expected: [AvatarClip: String] = [.blink: "still", .smile: "still", .yawn: "still", .workStart: "still", .workLoop: "typing", .workEnd: "typing"]
        for clip in AvatarClip.allCases {
            player.play(clip) {}
            XCTAssertTrue(player.cover.isUp, "over \(clip)")
            XCTAssertEqual(try look(player.cover.picture), expected[clip], "on the cover for \(clip)")
            player.stop()
            XCTAssertEqual(try look(player.cover.picture), "still", "after a stop")
        }
    }

    /// After a clip that cannot play has been stood in for, the cover holds the pose the clip ended on: the still after
    /// `blink`, `smile`, `yawn` and `work-end`, the typing pose after `work-start` and `work-loop`.
    func testAfterEachClipEndsTheCoverHoldsThePoseItEndedOn() async throws {
        try writeStill(.red)
        try writeTyping(.blue)
        let player = AvatarPlayer(resources: AvatarResources(folders: [folder]), standIn: .milliseconds(20))
        let expected: [AvatarClip: String] = [.blink: "still", .smile: "still", .yawn: "still", .workStart: "typing", .workLoop: "typing", .workEnd: "still"]
        for clip in AvatarClip.allCases {
            let ended = expectation(description: "\(clip) ended")
            var shown: String?
            player.play(clip) {
                shown = try? self.look(player.cover.picture)
                ended.fulfill()
            }
            await fulfillment(of: [ended], timeout: 5)
            XCTAssertEqual(shown, expected[clip], "after \(clip)")
        }
    }

    func testRestingPutsTheCoverUpWithTheStillWhateverPlayedBefore() throws {
        try writeStill(.red)
        try writeTyping(.blue)
        let player = AvatarPlayer(resources: AvatarResources(folders: [folder]), standIn: .milliseconds(20))
        player.play(.workLoop) {}
        XCTAssertEqual(try look(player.cover.picture), "typing")
        player.rest()
        XCTAssertEqual(try look(player.cover.picture), "still")
        XCTAssertTrue(player.cover.isUp)
        XCTAssertTrue(player.lanes.allSatisfy { !$0.isVisible })
    }

    /// A layer has drawn when it has been ready at two display refreshes after the one that first saw it ready, and not
    /// before: `isReadyForDisplay` can turn true before the frame reaches the screen.
    func testALayerHasDrawnTwoRefreshesAfterItWasFirstSeenReady() {
        var drawn = AvatarDrawn()
        XCTAssertFalse(drawn.hasDrawn, "before any refresh")
        drawn.refresh(ready: false)
        drawn.refresh(ready: false)
        XCTAssertFalse(drawn.hasDrawn, "not ready")
        drawn.refresh(ready: true)
        XCTAssertFalse(drawn.hasDrawn, "seen ready at this refresh")
        drawn.refresh(ready: true)
        XCTAssertFalse(drawn.hasDrawn, "one refresh after")
        drawn.refresh(ready: true)
        XCTAssertTrue(drawn.hasDrawn, "two refreshes after")
        drawn.refresh(ready: true)
        XCTAssertTrue(drawn.hasDrawn)
        drawn.refresh(ready: false)
        XCTAssertFalse(drawn.hasDrawn, "a layer that stops being ready starts again")
        drawn.refresh(ready: true)
        drawn.refresh(ready: true)
        XCTAssertFalse(drawn.hasDrawn)
    }

    /// The cover is invisible against the frames it stands in for only if the two pose pictures are the clips' first and
    /// last frames: the mean difference per colour channel is a few grey levels at most, decoded as the player decodes.
    func testThePosePicturesAreTheFirstAndLastFramesOfTheClips() async throws {
        let resources = AvatarResources.bundled
        func pixels(of pose: AvatarPose) throws -> [UInt8] {
            guard case let .still(image) = resources.picture(of: pose) else { throw XCTSkip("the \(pose) picture is not bundled") }
            return try bgra(of: XCTUnwrap(image.cgImage), side: 360)
        }
        let pictures: [AvatarPose: [UInt8]] = [.standing: try pixels(of: .standing), .typing: try pixels(of: .typing)]
        for clip in AvatarClip.allCases {
            let url = try XCTUnwrap(resources.clipURL(for: clip), "\(clip) is bundled")
            let asset = AVURLAsset(url: url)
            let tracks = try await asset.loadTracks(withMediaType: .video)
            let track = try XCTUnwrap(tracks.first)
            let reader = try AVAssetReader(asset: asset)
            let output = AVAssetReaderTrackOutput(track: track, outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
            reader.add(output)
            XCTAssertTrue(reader.startReading())
            var first: CVPixelBuffer?
            var last: CVPixelBuffer?
            while let sample = output.copyNextSampleBuffer() {
                guard let buffer = CMSampleBufferGetImageBuffer(sample) else { continue }
                if first == nil { first = buffer }
                last = buffer
            }
            let firstFrame = pixelBytes(of: try XCTUnwrap(first))
            let lastFrame = pixelBytes(of: try XCTUnwrap(last))
            XCTAssertLessThan(meanDifference(firstFrame, try XCTUnwrap(pictures[clip.startPose])), 4, "\(clip)'s first frame and the \(clip.startPose) picture")
            XCTAssertLessThan(meanDifference(lastFrame, try XCTUnwrap(pictures[clip.endPose])), 4, "\(clip)'s last frame and the \(clip.endPose) picture")
        }
    }

    // MARK: Never an undrawn layer on top

    /// A clip that starts from rest and goes back to it, for every clip, with the real clips and pictures in a window and
    /// the avatar's own surface. At each of the two changes, at every sample: either the cover is up, or the lane on top
    /// has drawn; no lane that has not drawn is ever visible above the cover; and neither is there a moment with neither a
    /// cover nor a drawn lane. The lane prepares under the cover, paused, and the cover comes down once, after it has drawn.
    func testFromRestToEachClipAndBackAnUndrawnLaneIsNeverOnTop() async throws {
        let player = AvatarPlayer()
        let window = try showWindow(AvatarPlayerSurface(layers: player.layers).frame(width: 180, height: 180))
        defer { window.isHidden = true }

        for clip in AvatarClip.allCases {
            player.rest()
            try await Task.sleep(for: .milliseconds(200))

            let watch = ScreenWatch(player)
            watch.expectedPose = clip.startPose
            let ended = expectation(description: "\(clip) ended")
            player.play(clip) {
                // From here on the clip is over: count what is on screen as the avatar goes back to rest.
                watch.expectedPose = .standing
                player.rest()
                ended.fulfill()
            }
            await fulfillment(of: [ended], timeout: 20)
            try await Task.sleep(for: .milliseconds(300))
            let seen = watch.stop()

            XCTAssertGreaterThan(seen.samples, 100, "\(clip): the watch ran")
            XCTAssertGreaterThan(seen.preparing, 0, "\(clip): the lane was never sampled preparing under the cover (\(seen))")
            XCTAssertGreaterThan(seen.drawn, 50, "\(clip): the clip never showed (\(seen))")
            XCTAssertGreaterThan(seen.restOnly, 50, "\(clip): the cover is up alone after the rest (\(seen))")
            XCTAssertEqual(seen.coverLowered, 1, "\(clip): the cover comes down once, for the clip (\(seen))")
            XCTAssertGreaterThanOrEqual(seen.shortestWait ?? .zero, twoRefreshes(on: window), "\(clip): the cover came down less than two refreshes after the lane reported a frame (\(seen))")
            XCTAssertEqual(seen.undrawnShown, 0, "\(clip): a lane that had not drawn was shown (\(seen))")
            XCTAssertEqual(seen.bare, 0, "\(clip): neither a cover nor a drawn lane (\(seen))")
            XCTAssertEqual(seen.playingUnderCover, 0, "\(clip): a clip played under the cover (\(seen))")
            XCTAssertEqual(seen.wrongPicture, 0, "\(clip): the cover showed the wrong pose (\(seen))")
            XCTAssertNil(seen.firstViolation, "\(clip): \(seen.firstViolation ?? "")")
            XCTAssertTrue(player.cover.isUp, "\(clip): at rest the cover is up")
            XCTAssertTrue(player.lanes.allSatisfy { !$0.isVisible }, "\(clip): at rest no lane is visible")
        }
    }

    /// What the director plays while Alfred works: `work-start`, then `work-loop` twice (a pass after a pass), then
    /// `work-end`, each started in the previous clip's `finished` as the conductor does. At each of the three seams and the
    /// start, at every sample, the same: a cover or a drawn lane on top, the cover comes down once per clip.
    func testAcrossWorkStartWorkLoopWorkLoopAndWorkEndAnUndrawnLaneIsNeverOnTop() async throws {
        let player = AvatarPlayer()
        let window = try showWindow(AvatarPlayerSurface(layers: player.layers).frame(width: 180, height: 180))
        defer { window.isHidden = true }
        try await Task.sleep(for: .milliseconds(200))

        let sequence: [AvatarClip] = [.workStart, .workLoop, .workLoop, .workEnd]
        let watch = ScreenWatch(player)
        let done = expectation(description: "the chain ended")
        func play(_ index: Int) {
            guard index < sequence.count else {
                done.fulfill()
                return
            }
            watch.expectedPose = sequence[index].startPose
            player.play(sequence[index]) { play(index + 1) }
        }
        play(0)
        await fulfillment(of: [done], timeout: 60)
        let seen = watch.stop()

        XCTAssertGreaterThan(seen.samples, 1000, "the watch ran")
        XCTAssertGreaterThan(seen.preparing, 3, "the lanes were sampled preparing under the cover (\(seen))")
        XCTAssertEqual(seen.coverLowered, sequence.count, "the cover comes down once for each clip (\(seen))")
        XCTAssertGreaterThanOrEqual(seen.shortestWait ?? .zero, twoRefreshes(on: window), "the cover came down less than two refreshes after the lane reported a frame (\(seen))")
        XCTAssertEqual(seen.undrawnShown, 0, "a lane that had not drawn was shown (\(seen))")
        XCTAssertEqual(seen.bare, 0, "neither a cover nor a drawn lane (\(seen))")
        XCTAssertEqual(seen.playingUnderCover, 0, "a clip played under the cover (\(seen))")
        XCTAssertEqual(seen.wrongPicture, 0, "the cover showed the wrong pose (\(seen))")
        XCTAssertNil(seen.firstViolation, seen.firstViolation ?? "")
        XCTAssertFalse(player.cover.isUp, "the last clip's last frame is on screen")
        XCTAssertTrue(player.lanes.contains { $0.isVisible && $0.hasDrawn }, "and it has drawn")
    }

    /// A clip that never draws leaves the cover up and no lane visible: an unreadable file is not a clip, and a clip that
    /// has not drawn by `firstFrameTimeout` counts as one that cannot play.
    func testAClipThatNeverDrawsLeavesTheCoverUpAndNoLaneVisible() async throws {
        try writeStill(.red)
        try writeTyping(.blue)

        // An unreadable file.
        do {
            try Data("this is not a video".utf8).write(to: folder.appending(path: "blink.mp4"))
            let player = AvatarPlayer(resources: AvatarResources(folders: [folder]), standIn: .milliseconds(300))
            let window = try showWindow(AvatarPlayerSurface(layers: player.layers).frame(width: 180, height: 180))
            defer { window.isHidden = true }
            try await Task.sleep(for: .milliseconds(100))
            let watch = ScreenWatch(player)
            let ended = expectation(description: "the unreadable clip was stood in for")
            player.play(.blink) { ended.fulfill() }
            await fulfillment(of: [ended], timeout: 5)
            let seen = watch.stop()
            XCTAssertGreaterThan(seen.samples, 100, "the watch ran")
            XCTAssertEqual(seen.restOnly, seen.samples, "the cover alone, all the time (\(seen))")
            XCTAssertEqual(seen.drawn + seen.undrawnShown + seen.bare, 0, "(\(seen))")
            XCTAssertTrue(player.cover.isUp)
            XCTAssertTrue(player.lanes.allSatisfy { !$0.isVisible && $0.player.currentItem == nil })
        }

        // A good clip that is not drawn in time: 10 ms is less than the three display refreshes that a lane needs to have
        // drawn, at any refresh rate. The lane prepares under the cover, is given up, and is cleared.
        do {
            try await writeClip(to: folder.appending(path: "smile.mp4"), frames: 12)
            let player = AvatarPlayer(resources: AvatarResources(folders: [folder]), standIn: .milliseconds(100), firstFrameTimeout: .milliseconds(10))
            let window = try showWindow(AvatarPlayerSurface(layers: player.layers).frame(width: 180, height: 180))
            defer { window.isHidden = true }
            try await Task.sleep(for: .milliseconds(100))
            let watch = ScreenWatch(player)
            let ended = expectation(description: "the clip that was not drawn in time was stood in for")
            player.play(.smile) { ended.fulfill() }
            await fulfillment(of: [ended], timeout: 5)
            let seen = watch.stop()
            XCTAssertGreaterThan(seen.samples, 50, "the watch ran")
            XCTAssertEqual(seen.coverLowered, 0, "the cover stayed up (\(seen))")
            XCTAssertEqual(seen.drawn + seen.undrawnShown + seen.bare, 0, "(\(seen))")
            XCTAssertNil(seen.firstViolation, seen.firstViolation ?? "")
            XCTAssertTrue(player.cover.isUp)
            XCTAssertTrue(player.lanes.allSatisfy { !$0.isVisible && $0.player.currentItem == nil }, "the lane that did not draw is cleared")
        }
    }

    /// A stop, or another clip, while a clip is preparing under the cover: the cover stays up, the lane that was
    /// preparing is cleared or replaced, and the cancelled clip never takes the cover down later.
    func testStoppingOrReplacingAClipWhileItPreparesNeverLowersTheCoverForIt() async throws {
        let player = AvatarPlayer()
        let window = try showWindow(AvatarPlayerSurface(layers: player.layers).frame(width: 180, height: 180))
        defer { window.isHidden = true }
        func waitUntilAClipPrepares() async throws {
            var waited = 0
            while waited < 2000, !player.lanes.contains(where: { $0.player.currentItem != nil }) {
                try await Task.sleep(for: .milliseconds(1))
                waited += 1
            }
            XCTAssertTrue(player.lanes.contains { $0.player.currentItem != nil }, "a clip was attached")
        }

        // A stop.
        let stopped = expectation(description: "a stopped clip does not end")
        stopped.isInverted = true
        player.play(.workLoop) { stopped.fulfill() }
        try await waitUntilAClipPrepares()
        player.stop()
        XCTAssertTrue(player.cover.isUp)
        XCTAssertTrue(player.lanes.allSatisfy { !$0.isVisible && $0.player.currentItem == nil })
        await fulfillment(of: [stopped], timeout: 0.8)
        XCTAssertTrue(player.cover.isUp, "the stopped clip did not take the cover down")
        XCTAssertTrue(player.lanes.allSatisfy { !$0.isVisible && $0.player.currentItem == nil })

        // Another clip.
        let watch = ScreenWatch(player)
        let replaced = expectation(description: "the replaced clip does not end")
        replaced.isInverted = true
        let second = expectation(description: "the second clip ended")
        watch.expectedPose = .typing
        player.play(.workLoop) { replaced.fulfill() }
        try await waitUntilAClipPrepares()
        watch.expectedPose = .standing
        player.play(.blink) { second.fulfill() }
        await fulfillment(of: [replaced, second], timeout: 20)
        let seen = watch.stop()
        XCTAssertEqual(seen.coverLowered, 1, "the cover came down once, for the second clip (\(seen))")
        XCTAssertEqual(seen.undrawnShown, 0, "a lane that had not drawn was shown (\(seen))")
        XCTAssertEqual(seen.bare, 0, "neither a cover nor a drawn lane (\(seen))")
        XCTAssertEqual(seen.wrongPicture, 0, "the cover showed the wrong pose (\(seen))")
        XCTAssertNil(seen.firstViolation, seen.firstViolation ?? "")
    }

    // MARK: Files

    private func writeStill(_ color: UIColor = .red) throws {
        try writePicture("still.png", color)
    }

    private func writeTyping(_ color: UIColor = .blue) throws {
        try writePicture("typing.png", color)
    }

    private func writePicture(_ name: String, _ color: UIColor) throws {
        let image = UIGraphicsImageRenderer(size: CGSize(width: 16, height: 16)).image { context in
            color.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 16, height: 16))
        }
        try XCTUnwrap(image.pngData()).write(to: folder.appending(path: name))
    }

    /// Which of the tests' pictures this is: the still is red and the typing pose is blue.
    private func look(_ picture: AvatarPicture) throws -> String {
        switch picture {
        case .placeholder: return "placeholder"
        case .clip: return "clip"
        case let .still(image):
            var pixel = [UInt8](repeating: 0, count: 4)
            let context = try XCTUnwrap(CGContext(
                data: &pixel, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4,
                space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
            ))
            context.draw(try XCTUnwrap(image.cgImage), in: CGRect(x: 0, y: 0, width: 1, height: 1))
            return pixel[0] > 200 ? "still" : pixel[2] > 200 ? "typing" : "other"
        }
    }

    /// Two display refreshes of the window's screen, less the 5 ms that the watch's sampling every millisecond and its
    /// scheduling may take off a wait that it measures with its own clock.
    private func twoRefreshes(on window: UIWindow) -> Duration {
        let frames = window.windowScene?.screen.maximumFramesPerSecond ?? 60
        return .seconds(2.0 / Double(frames)) - .milliseconds(5)
    }

    /// A window on the simulator's screen with `content` in it, so that the video layers in it draw.
    private func showWindow(_ content: some View) throws -> UIWindow {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first, "no window scene")
        let window = UIWindow(windowScene: scene)
        window.rootViewController = UIHostingController(rootView: content)
        window.makeKeyAndVisible()
        window.layoutIfNeeded()
        return window
    }

    /// A small H.264 video: `frames` frames at 24 fps, grey squares.
    private func writeClip(to url: URL, frames: Int = 6) async throws {
        let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: 64,
            AVVideoHeightKey: 64,
        ])
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
            kCVPixelBufferWidthKey as String: 64,
            kCVPixelBufferHeightKey as String: 64,
        ])
        writer.add(input)
        XCTAssertTrue(writer.startWriting())
        writer.startSession(atSourceTime: .zero)
        for frame in 0..<frames {
            while !input.isReadyForMoreMediaData {
                try await Task.sleep(for: .milliseconds(5))
            }
            let pool = try XCTUnwrap(adaptor.pixelBufferPool)
            var buffer: CVPixelBuffer?
            CVPixelBufferPoolCreatePixelBuffer(nil, pool, &buffer)
            let pixels = try XCTUnwrap(buffer)
            CVPixelBufferLockBaseAddress(pixels, [])
            memset(CVPixelBufferGetBaseAddress(pixels), Int32(40 + frame * 10), CVPixelBufferGetDataSize(pixels))
            CVPixelBufferUnlockBaseAddress(pixels, [])
            XCTAssertTrue(adaptor.append(pixels, withPresentationTime: CMTime(value: CMTimeValue(frame), timescale: 24)))
        }
        input.markAsFinished()
        await writer.finishWriting()
        XCTAssertEqual(writer.status, .completed, "\(String(describing: writer.error))")
    }

    /// A picture drawn as 8-bit BGRA in sRGB, `side` points square.
    private func bgra(of image: CGImage, side: Int) throws -> [UInt8] {
        var bytes = [UInt8](repeating: 0, count: side * side * 4)
        let info = CGBitmapInfo.byteOrder32Little.rawValue | CGImageAlphaInfo.premultipliedFirst.rawValue
        let context = try XCTUnwrap(CGContext(
            data: &bytes, width: side, height: side, bitsPerComponent: 8, bytesPerRow: side * 4,
            space: try XCTUnwrap(CGColorSpace(name: CGColorSpace.sRGB)), bitmapInfo: info
        ))
        context.draw(image, in: CGRect(x: 0, y: 0, width: side, height: side))
        return bytes
    }

    private func pixelBytes(of buffer: CVPixelBuffer) -> [UInt8] {
        CVPixelBufferLockBaseAddress(buffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
        let width = CVPixelBufferGetWidth(buffer)
        let height = CVPixelBufferGetHeight(buffer)
        let stride = CVPixelBufferGetBytesPerRow(buffer)
        guard let base = CVPixelBufferGetBaseAddress(buffer)?.assumingMemoryBound(to: UInt8.self) else { return [] }
        var bytes = [UInt8](repeating: 0, count: width * height * 4)
        for row in 0..<height {
            for column in 0..<(width * 4) {
                bytes[row * width * 4 + column] = base[row * stride + column]
            }
        }
        return bytes
    }

    /// The mean difference per colour channel, in grey levels out of 255.
    private func meanDifference(_ a: [UInt8], _ b: [UInt8]) -> Double {
        guard a.count == b.count, !a.isEmpty else { return .infinity }
        var sum = 0
        var count = 0
        for pixel in stride(from: 0, to: a.count, by: 4) {
            for channel in 0..<3 {
                sum += abs(Int(a[pixel + channel]) - Int(b[pixel + channel]))
                count += 1
            }
        }
        return Double(sum) / Double(count)
    }
}

private extension AvatarLane {
    /// Whether the lane's layer would be seen if nothing were over it: not hidden and not transparent. Whatever is on it, a
    /// video frame or nothing, covers what is under it.
    var isVisible: Bool {
        !layer.isHidden && layer.opacity > 0
    }
}

/// Looks at the avatar's circle every millisecond or so, from the layers of a player in a window, and judges each sample
/// by the rule: what is on top is either the cover, up and opaque, or a lane that has drawn. A lane that is visible is
/// *shown* when nothing opaque is over it, that is when the cover is down (or the lane is above it); a shown lane must have
/// drawn, and the circle must always have a cover or a drawn lane.
@MainActor
private final class ScreenWatch {
    struct Counts: CustomStringConvertible {
        var samples = 0
        /// The cover is up and no lane is visible.
        var restOnly = 0
        /// The cover is up and a lane that has not drawn yet is visible under it: a clip preparing.
        var preparing = 0
        /// The cover is down and the lane on top has drawn.
        var drawn = 0
        /// The times the cover went from up to down.
        var coverLowered = 0
        /// The shortest time from the sample that first saw the lane on top report `isReadyForDisplay` to the sample that
        /// first saw the cover down, as the watch measures it with its own clock.
        var shortestWait: Duration?
        /// How long the cover was up before each time it came down, from the sample that first saw it up (or the first
        /// sample), as the watch measures it.
        var holds: [Duration] = []
        /// A lane that has not drawn was shown (the cover was down, or the lane was above it).
        var undrawnShown = 0
        /// Neither the cover nor a drawn lane was on top.
        var bare = 0
        /// The cover was up and a clip was playing under it: it should be prepared paused, at its start.
        var playingUnderCover = 0
        /// The cover was up with a pose other than `expectedPose`.
        var wrongPicture = 0
        /// The first sample that broke a rule.
        var firstViolation: String?

        var description: String {
            "\(samples) samples: \(restOnly) with the cover alone, \(preparing) with a lane preparing under the cover, \(drawn) with a drawn lane on top, the cover lowered \(coverLowered) times after at least \(shortestWait.map { "\($0)" } ?? "-") and up for \(holds.map { "\($0)" }); \(undrawnShown) with an undrawn lane shown, \(bare) with neither cover nor drawn lane, \(playingUnderCover) with a clip playing under the cover, \(wrongPicture) with the wrong pose on the cover"
        }
    }

    private(set) var counts = Counts()
    /// The pose the cover must show whenever it is up, or nil to leave it unchecked.
    var expectedPose: AvatarPose?

    private let player: AvatarPlayer
    private var task: Task<Void, Never>?
    private var wasCoverUp: Bool?
    private var coverUpSince: ContinuousClock.Instant?
    /// When a sample first saw a visible lane ready for display.
    private var readySince: [ObjectIdentifier: ContinuousClock.Instant] = [:]
    /// Which pose a cover picture is, by the picture's pixels against the real files; found once for each picture.
    private var poses: [ObjectIdentifier: AvatarPose?] = [:]
    private lazy var references: [AvatarPose: [UInt8]] = {
        var found: [AvatarPose: [UInt8]] = [:]
        for (pose, name) in [(AvatarPose.standing, "still.png"), (.typing, "typing.png")] {
            if let image = Bundle.main.resourceURL.flatMap({ UIImage(contentsOfFile: $0.appending(path: name).path) })?.cgImage {
                found[pose] = Self.thumbnail(image)
            }
        }
        return found
    }()

    init(_ player: AvatarPlayer) {
        self.player = player
        task = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                self?.sample()
                try? await Task.sleep(for: .milliseconds(1))
            }
        }
    }

    /// Stops looking and returns what was seen.
    func stop() -> Counts {
        task?.cancel()
        task = nil
        return counts
    }

    private func sample() {
        let cover = player.cover.layer
        let coverUp = cover.superlayer != nil && !cover.isHidden && cover.opacity == 1 && cover.contents != nil && cover.bounds.width > 0
        let visible = player.lanes.filter { $0.layer.superlayer != nil && $0.isVisible }
        let shown = coverUp ? visible.filter { $0.layer.zPosition > cover.zPosition } : visible
        let under = visible.filter { lane in !shown.contains { $0 === lane } }
        counts.samples += 1
        let now = ContinuousClock.now
        for lane in player.lanes {
            let id = ObjectIdentifier(lane)
            if lane.isVisible, lane.layer.isReadyForDisplay {
                if readySince[id] == nil { readySince[id] = now }
            } else {
                readySince[id] = nil
            }
        }
        if coverUp, wasCoverUp != true { coverUpSince = now }
        if wasCoverUp == true, !coverUp {
            counts.coverLowered += 1
            if let since = coverUpSince { counts.holds.append(now - since) }
            if let top = shown.max(by: { $0.layer.zPosition < $1.layer.zPosition }), let since = readySince[ObjectIdentifier(top)] {
                counts.shortestWait = min(counts.shortestWait ?? .seconds(60), now - since)
            }
        }
        wasCoverUp = coverUp

        if shown.contains(where: { !($0.hasDrawn && $0.layer.isReadyForDisplay) }) {
            counts.undrawnShown += 1
            violation("a visible lane that has not drawn was shown (cover up: \(coverUp))")
        }
        if !coverUp, !shown.contains(where: { $0.hasDrawn }) {
            counts.bare += 1
            violation("neither the cover nor a drawn lane was on top")
        }
        if coverUp, under.contains(where: { $0.player.rate != 0 }) {
            counts.playingUnderCover += 1
            violation("a clip played under the cover")
        }
        if coverUp, let expected = expectedPose, pose(ofCover: cover) != expected {
            counts.wrongPicture += 1
            violation("the cover showed \(String(describing: pose(ofCover: cover))), not \(expected)")
        }

        if coverUp, visible.isEmpty {
            counts.restOnly += 1
        } else if coverUp, visible.contains(where: { !$0.hasDrawn }) {
            counts.preparing += 1
        } else if !coverUp, shown.contains(where: { $0.hasDrawn }) {
            counts.drawn += 1
        }
    }

    private func violation(_ what: String) {
        if counts.firstViolation == nil { counts.firstViolation = "sample \(counts.samples): \(what)" }
    }

    private func pose(ofCover cover: CALayer) -> AvatarPose? {
        guard let contents = cover.contents else { return nil }
        let key = ObjectIdentifier(contents as AnyObject)
        if let known = poses[key] { return known }
        let thumbnail = Self.thumbnail(contents as! CGImage)
        let found = references.first { Self.meanDifference($0.value, thumbnail) < 3 }?.key
        poses[key] = .some(found)
        return found
    }

    /// The picture as 16 by 16 pixels of 8-bit RGBA.
    private static func thumbnail(_ image: CGImage) -> [UInt8] {
        var bytes = [UInt8](repeating: 0, count: 16 * 16 * 4)
        bytes.withUnsafeMutableBytes { buffer in
            let context = CGContext(
                data: buffer.baseAddress, width: 16, height: 16, bitsPerComponent: 8, bytesPerRow: 64,
                space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
            )
            context?.interpolationQuality = .medium
            context?.draw(image, in: CGRect(x: 0, y: 0, width: 16, height: 16))
        }
        return bytes
    }

    private static func meanDifference(_ a: [UInt8], _ b: [UInt8]) -> Double {
        var sum = 0
        for index in a.indices { sum += abs(Int(a[index]) - Int(b[index])) }
        return Double(sum) / Double(a.count)
    }
}
