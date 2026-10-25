import AlfredKit
import Foundation
import XCTest

final class LiveEventFixtureTests: XCTestCase {
    private func decode(_ file: URL) throws -> LiveEvent {
        try JSONDecoder().decode(LiveEvent.self, from: Data(contentsOf: file))
    }

    func testEveryLiveFixtureDecodesToAKnownCase() throws {
        let files = try Fixtures.jsonFiles(in: "live")
        XCTAssertGreaterThanOrEqual(files.count, 3, "a message delta and two run steps")
        for file in files {
            let name = file.lastPathComponent
            do {
                let event = try decode(file)
                if case let .unknown(type) = event.payload {
                    XCTFail("\(name) decoded as the unknown type \(type)")
                }
            } catch {
                XCTFail("\(name) does not decode: \(error)")
            }
        }
    }

    func testMessageDeltaFieldsAreDecoded() throws {
        let event = try decode(Fixtures.directory.appending(path: "live/message-delta.json"))
        XCTAssertEqual(event.at.timeIntervalSince1970, 1_792_917_121.12, accuracy: 0.001)
        guard case let .messageDelta(runId, streamId, text) = event.payload else {
            return XCTFail("expected a message.delta event, got \(event.payload)")
        }
        XCTAssertEqual(runId, "k7m2qa")
        XCTAssertEqual(streamId, "k7m2qa.2")
        XCTAssertEqual(text, "我先查一下官网的定价页。")
    }

    func testRunStepFieldsAreDecoded() throws {
        let event = try decode(Fixtures.directory.appending(path: "live/run-step-subagent.json"))
        guard case let .runStep(runId, step) = event.payload else {
            return XCTFail("expected a run.step event, got \(event.payload)")
        }
        XCTAssertEqual(runId, "h6w4tz")
        XCTAssertEqual(step.at, event.at)
        XCTAssertEqual(step.tool, "Read")
        XCTAssertEqual(step.detail, "reports/vps.md")
        XCTAssertEqual(step.agent, "reviewer")
    }
}

final class StreamEventTests: XCTestCase {
    func testAFrameWithAnIDIsAStoredEvent() throws {
        let file = Fixtures.directory.appending(path: "events/message-created-app-in.json")
        let frame = try JSONDecoder().decode(StreamEvent.self, from: Data(contentsOf: file))
        guard case let .event(event) = frame else {
            return XCTFail("expected a stored event, got \(frame)")
        }
        XCTAssertEqual(event.id, 1)
    }

    func testAFrameWithoutAnIDIsALiveEvent() throws {
        let file = Fixtures.directory.appending(path: "live/message-delta.json")
        let frame = try JSONDecoder().decode(StreamEvent.self, from: Data(contentsOf: file))
        guard case let .live(event) = frame else {
            return XCTFail("expected a live event, got \(frame)")
        }
        guard case .messageDelta = event.payload else {
            return XCTFail("expected a message.delta event, got \(event.payload)")
        }
    }

    func testEveryFutureLiveFixtureIsALiveEventOfAnUnknownType() throws {
        let files = try Fixtures.jsonFiles(in: "future").filter { $0.lastPathComponent.hasPrefix("live-") }
        XCTAssertGreaterThanOrEqual(files.count, 1)
        for file in files {
            let name = file.lastPathComponent
            do {
                let frame = try JSONDecoder().decode(StreamEvent.self, from: Data(contentsOf: file))
                guard case let .live(event) = frame else {
                    return XCTFail("\(name) is not a live event")
                }
                guard case .unknown = event.payload else {
                    return XCTFail("\(name) has a type the client knows")
                }
            } catch {
                XCTFail("\(name) does not decode: \(error)")
            }
        }
    }
}
