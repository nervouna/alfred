import AVFoundation
import SwiftUI
import UIKit
import XCTest

@testable import Alfred

/// The avatar's fallbacks: the clip, else the picture of the pose it starts on (the still, or the typing pose), else a
/// navy circle with a person in it, and a stand-in of two seconds for a clip that cannot play. The picture under the
/// video follows the clips' poses, and a clip that follows another one leaves no gap. The files are made in a folder of
/// the test's own.
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
        XCTAssertEqual(player.underlay, .placeholder)
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
        let player = AvatarPlayer(resources: AvatarResources(folders: [folder]), firstFrameTimeout: .milliseconds(100))
        let ended = expectation(description: "the clip ended")
        player.play(.blink) { ended.fulfill() }
        await fulfillment(of: [ended], timeout: 10)

        XCTAssertTrue(player.lanes.allSatisfy { $0.player.isMuted })
        let item = try XCTUnwrap(player.lanes.compactMap { $0.player.currentItem }.first, "the last frame stays until something replaces it")
        XCTAssertEqual(item.currentTime().seconds, 0.5, accuracy: 0.1, "it played to the end")
        player.rest()
        XCTAssertTrue(player.lanes.allSatisfy { $0.player.currentItem == nil })
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

    // MARK: The pictures under the clips

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

    /// Under each clip is the picture of the pose it starts on: the still under `blink`, `smile`, `yawn` and
    /// `work-start`, the typing pose under `work-loop` and `work-end`.
    func testEachClipHasThePictureOfItsStartingPoseUnderIt() throws {
        try writeStill(.red)
        try writeTyping(.blue)
        let player = AvatarPlayer(resources: AvatarResources(folders: [folder]), standIn: .milliseconds(20))
        XCTAssertEqual(try look(player.underlay), "still", "at rest")
        let expected: [AvatarClip: String] = [.blink: "still", .smile: "still", .yawn: "still", .workStart: "still", .workLoop: "typing", .workEnd: "typing"]
        for clip in AvatarClip.allCases {
            player.play(clip) {}
            XCTAssertEqual(try look(player.underlay), expected[clip], "under \(clip)")
            player.stop()
            XCTAssertEqual(try look(player.underlay), "still", "after a stop")
        }
    }

    /// After a clip ends, the pose it ended on is what shows until the next clip draws: the still after `blink`,
    /// `smile`, `yawn` and `work-end`, the typing pose after `work-start` and `work-loop`.
    func testAfterEachClipEndsTheUnderlayIsThePoseItEndedOn() async throws {
        try writeStill(.red)
        try writeTyping(.blue)
        let player = AvatarPlayer(resources: AvatarResources(folders: [folder]), standIn: .milliseconds(20))
        let expected: [AvatarClip: String] = [.blink: "still", .smile: "still", .yawn: "still", .workStart: "typing", .workLoop: "typing", .workEnd: "still"]
        for clip in AvatarClip.allCases {
            let ended = expectation(description: "\(clip) ended")
            var shown: String?
            player.play(clip) {
                shown = try? self.look(player.underlay)
                ended.fulfill()
            }
            await fulfillment(of: [ended], timeout: 5)
            XCTAssertEqual(shown, expected[clip], "after \(clip)")
        }
    }

    func testRestingShowsTheStillWhateverPlayedBefore() throws {
        try writeStill(.red)
        try writeTyping(.blue)
        let player = AvatarPlayer(resources: AvatarResources(folders: [folder]), standIn: .milliseconds(20))
        player.play(.workLoop) {}
        XCTAssertEqual(try look(player.underlay), "typing")
        player.rest()
        XCTAssertEqual(try look(player.underlay), "still")
    }

    // MARK: Clips that follow one another

    /// The seam between two clips: the last frame of the first stays on screen until the second has its first frame, so
    /// at no moment is there no frame at all, and the picture under the video, which is not the pose of that frame, never
    /// shows. The surface is the avatar's own, in a window, and a layer's `isReadyForDisplay` says that it has a frame.
    func testTheLastFrameStaysUntilTheNextClipHasItsFirst() async throws {
        try writeStill(.red)
        try writeTyping(.blue)
        for name in ["work-loop", "work-end"] {
            try await writeClip(to: folder.appending(path: name + ".mp4"), frames: 12)
        }
        let player = AvatarPlayer(resources: AvatarResources(folders: [folder]))
        let window = try showWindow(AvatarPlayerSurface(layers: player.layers).frame(width: 180, height: 180))
        defer { window.isHidden = true }

        let first = expectation(description: "the first pass ended")
        player.play(.workLoop) { first.fulfill() }
        await fulfillment(of: [first], timeout: 10)
        XCTAssertTrue(player.layers.contains { $0.isReadyForDisplay }, "the first clip never drew a frame, so the seam cannot be checked")

        // From the end of the first clip until after the last one has started, a frame is always on screen, and no lane
        // is on screen without one.
        let screen = ScreenWatch(player)
        var gaps = 0
        var samples = 0
        let watch = Task { @MainActor in
            while !Task.isCancelled {
                samples += 1
                if !player.layers.contains(where: { $0.isReadyForDisplay }) { gaps += 1 }
                try? await Task.sleep(for: .milliseconds(1))
            }
        }
        let second = expectation(description: "the second clip ended")
        player.play(.workLoop) { second.fulfill() }
        await fulfillment(of: [second], timeout: 10)
        let third = expectation(description: "the third clip ended")
        player.play(.workEnd) { third.fulfill() }
        await fulfillment(of: [third], timeout: 10)
        watch.cancel()
        let seen = screen.stop()

        XCTAssertGreaterThan(samples, 100, "the watch ran")
        XCTAssertEqual(gaps, 0, "a frame was missing in \(gaps) of \(samples) samples across the seams")
        XCTAssertEqual(seen.loading, 0, "a lane was on screen before it had its first frame (\(seen))")
        XCTAssertEqual(seen.cleared, 0, "an empty lane was on screen (\(seen))")
        XCTAssertEqual(seen.blank, 0, "neither the picture nor a frame was there (\(seen))")
        XCTAssertTrue(player.layers.contains { $0.isReadyForDisplay }, "the last frame of the last clip stays")
    }

    /// The clip that ended is taken off its player only once the next one is on screen, never before.
    func testTheClipThatEndedIsOnlyTakenAwayOnceTheNextOneDraws() async throws {
        try await writeClip(to: folder.appending(path: "work-loop.mp4"), frames: 12)
        let player = AvatarPlayer(resources: AvatarResources(folders: [folder]))
        let window = try showWindow(AvatarPlayerSurface(layers: player.layers).frame(width: 180, height: 180))
        defer { window.isHidden = true }

        let first = expectation(description: "the first pass ended")
        player.play(.workLoop) { first.fulfill() }
        await fulfillment(of: [first], timeout: 10)
        let outgoing = try XCTUnwrap(player.lanes.first { $0.player.currentItem != nil }, "the clip's last frame stays on its player")

        let second = expectation(description: "the second pass ended")
        var takenAway: Bool?
        var incomingDrew = false
        let watch = Task { @MainActor in
            while !Task.isCancelled {
                if player.lanes.contains(where: { $0 !== outgoing && $0.layer.isReadyForDisplay }) { incomingDrew = true }
                if takenAway == nil, outgoing.player.currentItem == nil { takenAway = incomingDrew }
                try? await Task.sleep(for: .milliseconds(1))
            }
        }
        player.play(.workLoop) { second.fulfill() }
        await fulfillment(of: [second], timeout: 10)
        watch.cancel()
        XCTAssertEqual(takenAway, true, "the first clip left its player before the second one had drawn (nil: it never left)")
    }

    // MARK: Starting and ending a clip at rest

    /// A clip that starts from rest: the circle shows the picture under the video until the clip's first frame is drawn,
    /// and from then on that frame. A lane is on screen only once it has a frame, so at no sample is there a lane on
    /// screen that has none (it would cover the picture with nothing), and at no sample is there neither the picture nor a
    /// frame. The real clips and pictures, played through the avatar's own surface in a window.
    func testRestToEachIdleClipShowsThePictureThenTheFirstFrameNeverAnEmptyLane() async throws {
        let player = AvatarPlayer()
        let window = try showWindow(AvatarPlayerSurface(layers: player.layers).frame(width: 180, height: 180))
        defer { window.isHidden = true }

        for clip in [AvatarClip.blink, .smile, .yawn, .workStart] {
            player.rest()
            XCTAssertTrue(player.lanes.allSatisfy { !$0.isOnScreen }, "\(clip): at rest no lane is on screen")
            try await Task.sleep(for: .milliseconds(200))

            let watch = ScreenWatch(player)
            let ended = expectation(description: "\(clip) ended")
            player.play(clip) { ended.fulfill() }
            await fulfillment(of: [ended], timeout: 15)
            let seen = watch.stop()

            XCTAssertGreaterThan(seen.samples, 100, "\(clip): the watch ran")
            XCTAssertGreaterThan(seen.drawn, 0, "\(clip): the clip never drew a frame, so the start cannot be checked")
            XCTAssertGreaterThan(seen.pictureOnly, 0, "\(clip): the picture was never on its own, so the start was not sampled")
            XCTAssertEqual(seen.loading, 0, "\(clip): a lane was on screen before it had its first frame (\(seen))")
            XCTAssertEqual(seen.cleared, 0, "\(clip): an empty lane was on screen (\(seen))")
            XCTAssertEqual(seen.blank, 0, "\(clip): neither the picture nor a frame was there (\(seen))")
        }
    }

    /// A clip that ends and the avatar goes back to rest (the conductor's `rest()` when a pause follows): the last frame
    /// gives way to the picture, and at no sample is there an empty lane on screen or neither the picture nor a frame.
    func testEachIdleClipBackToRestShowsAFrameThenThePictureNeverAnEmptyLane() async throws {
        let player = AvatarPlayer()
        let window = try showWindow(AvatarPlayerSurface(layers: player.layers).frame(width: 180, height: 180))
        defer { window.isHidden = true }

        for clip in [AvatarClip.blink, .smile, .yawn, .workStart] {
            player.rest()
            try await Task.sleep(for: .milliseconds(200))

            let watch = ScreenWatch(player)
            let ended = expectation(description: "\(clip) ended")
            player.play(clip) {
                // From here on the clip is over: count what is on screen as the avatar goes back to rest.
                watch.reset()
                player.rest()
                ended.fulfill()
            }
            await fulfillment(of: [ended], timeout: 15)
            try await Task.sleep(for: .milliseconds(300))
            let seen = watch.stop()

            XCTAssertGreaterThan(seen.samples, 50, "\(clip): the watch ran")
            XCTAssertGreaterThan(seen.pictureOnly, 50, "\(clip): the picture shows after the rest (\(seen))")
            XCTAssertEqual(seen.drawn, 0, "\(clip): no frame stays on screen after the rest (\(seen))")
            XCTAssertEqual(seen.loading, 0, "\(clip): a lane with a clip was on screen without a frame (\(seen))")
            XCTAssertEqual(seen.cleared, 0, "\(clip): an empty lane was on screen (\(seen))")
            XCTAssertEqual(seen.blank, 0, "\(clip): neither the picture nor a frame was there (\(seen))")
            XCTAssertTrue(player.lanes.allSatisfy { !$0.isOnScreen }, "\(clip): at rest no lane is on screen")
        }
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

    /// A window on the simulator's screen with `content` in it, so that the video layers in it draw.
    private func showWindow(_ content: some View) throws -> UIWindow {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first, "no window scene")
        let window = UIWindow(windowScene: scene)
        window.rootViewController = UIHostingController(rootView: content)
        window.makeKeyAndVisible()
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
}

private extension AvatarLane {
    /// Whether the lane's layer is on screen: in the layer tree, not hidden and not transparent. Whatever is on it, a video
    /// frame or nothing, covers what is under it.
    var isOnScreen: Bool {
        layer.superlayer != nil && !layer.isHidden && layer.opacity > 0
    }
}

/// Looks at what the avatar's circle shows every millisecond or so, from the layers of a player in a window: whether a
/// video frame is on screen (a lane that is on screen and has drawn its first frame), whether only the picture under the
/// video is, and whether a lane is on screen that has no frame, which covers the picture with nothing.
@MainActor
private final class ScreenWatch {
    struct Counts: CustomStringConvertible {
        var samples = 0
        /// A video frame is on screen.
        var drawn = 0
        /// No frame is, and the picture under the video is.
        var pictureOnly = 0
        /// A lane that has a clip is on screen without its first frame.
        var loading = 0
        /// A lane that has no clip is on screen.
        var cleared = 0
        /// Neither a frame nor the picture.
        var blank = 0

        var description: String {
            "\(samples) samples: \(drawn) with a frame, \(pictureOnly) with the picture alone, \(loading) with a lane on screen before its first frame, \(cleared) with an empty lane on screen, \(blank) with nothing"
        }
    }

    private(set) var counts = Counts()
    private var task: Task<Void, Never>?

    init(_ player: AvatarPlayer) {
        task = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                self?.sample(player)
                try? await Task.sleep(for: .milliseconds(1))
            }
        }
    }

    /// Starts the counts again from here.
    func reset() {
        counts = Counts()
    }

    /// Stops looking and returns what was seen.
    func stop() -> Counts {
        task?.cancel()
        task = nil
        return counts
    }

    private func sample(_ player: AvatarPlayer) {
        let shown = player.lanes.filter(\.isOnScreen)
        let hasFrame = shown.contains { $0.layer.isReadyForDisplay }
        var hasPicture = false
        if case .still = player.underlay { hasPicture = true }
        counts.samples += 1
        if hasFrame {
            counts.drawn += 1
        } else if hasPicture {
            counts.pictureOnly += 1
        } else {
            counts.blank += 1
        }
        if shown.contains(where: { !$0.layer.isReadyForDisplay && $0.player.currentItem != nil }) { counts.loading += 1 }
        if shown.contains(where: { !$0.layer.isReadyForDisplay && $0.player.currentItem == nil }) { counts.cleared += 1 }
    }
}
