import AVFoundation
import UIKit
import XCTest

@testable import Alfred

/// The avatar's fallbacks: the clip, else the still, else a navy circle with a person in it, and a stand-in of two
/// seconds for a clip that cannot play. The files are made in a folder of the test's own.
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
        XCTAssertNil(player.player.currentItem, "nothing plays")
        await fulfillment(of: [ended], timeout: 5)
        XCTAssertGreaterThanOrEqual(ContinuousClock.now - began, .milliseconds(150))
        XCTAssertEqual(player.resting, .placeholder)
    }

    func testAnUnreadableClipIsStoodInForToo() async throws {
        try Data("this is not a video".utf8).write(to: folder.appending(path: "yawn.mp4"))
        let player = AvatarPlayer(resources: AvatarResources(folders: [folder]), standIn: .milliseconds(50))
        let ended = expectation(description: "the stand-in passed")
        player.play(.yawn) { ended.fulfill() }
        await fulfillment(of: [ended], timeout: 5)
        XCTAssertNil(player.player.currentItem)
    }

    func testAClipPlaysMutedToItsEnd() async throws {
        try await writeClip(to: folder.appending(path: "blink.mp4"), frames: 12)
        let player = AvatarPlayer(resources: AvatarResources(folders: [folder]))
        let ended = expectation(description: "the clip ended")
        player.play(.blink) { ended.fulfill() }
        await fulfillment(of: [ended], timeout: 10)

        XCTAssertTrue(player.player.isMuted)
        let item = try XCTUnwrap(player.player.currentItem, "the last frame stays until something replaces it")
        XCTAssertEqual(item.currentTime().seconds, 0.5, accuracy: 0.1, "it played to the end")
        player.rest()
        XCTAssertNil(player.player.currentItem)
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

    // MARK: Files

    private func writeStill() throws {
        let image = UIGraphicsImageRenderer(size: CGSize(width: 16, height: 16)).image { context in
            UIColor.red.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 16, height: 16))
        }
        try XCTUnwrap(image.pngData()).write(to: folder.appending(path: "still.png"))
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
