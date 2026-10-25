import AlfredKit
import Foundation
import XCTest

final class EventFixtureTests: XCTestCase {
    private func decode(_ file: URL) throws -> Event {
        try JSONDecoder().decode(Event.self, from: Data(contentsOf: file))
    }

    func testEveryEventFixtureDecodesToAKnownCase() throws {
        let files = try Fixtures.jsonFiles(in: "events")
        XCTAssertGreaterThanOrEqual(files.count, 8, "at least eight event fixtures")
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

    func testMessageFixtureFieldsAreDecoded() throws {
        let event = try decode(Fixtures.directory.appending(path: "events/message-created-app-in.json"))
        XCTAssertEqual(event.id, 1)
        XCTAssertEqual(event.at.timeIntervalSince1970, 1_792_917_000)
        guard case let .messageCreated(message) = event.payload else {
            return XCTFail("expected a message.created event, got \(event.payload)")
        }
        XCTAssertEqual(message.id, "m1001")
        XCTAssertEqual(message.channel, .app)
        XCTAssertEqual(message.direction, .inbound)
        XCTAssertEqual(message.text, "帮我查一下 VPS 价格")
        XCTAssertEqual(message.files, [])
        XCTAssertEqual(message.at, event.at)
        XCTAssertEqual(message.clientId, "c-7f3a9e")
        XCTAssertNil(message.runId)
        XCTAssertNil(message.error)
    }

    func testRunFixtureFieldsAreDecoded() throws {
        let event = try decode(Fixtures.directory.appending(path: "events/run-updated-done.json"))
        XCTAssertEqual(event.id, 5)
        guard case let .runUpdated(run) = event.payload else {
            return XCTFail("expected a run.updated event, got \(event.payload)")
        }
        XCTAssertEqual(run.id, "k7m2qa")
        XCTAssertEqual(run.kind, .task)
        XCTAssertEqual(run.title, "调研 VPS 价格")
        XCTAssertEqual(run.status, .done)
        XCTAssertEqual(run.model, "claude-sonnet-5-5")
        XCTAssertNil(run.taskId)
        XCTAssertNil(run.parentRunId)
        XCTAssertEqual(run.startedAt.timeIntervalSince1970, 1_792_917_005)
        XCTAssertEqual(try XCTUnwrap(run.endedAt).timeIntervalSince1970, 1_792_917_281.902, accuracy: 0.001)
        XCTAssertEqual(run.costUsd, 0.2513)
        XCTAssertEqual(run.files.map(\.path), ["reports/vps.md"])
        XCTAssertEqual(run.files.map(\.tool), ["Write"])
        XCTAssertNil(run.error)
    }
}

final class FutureFixtureTests: XCTestCase {
    private static let knownTypes: Set<String> = ["message.created", "run.updated"]

    func testEveryFutureFixtureDecodesWithoutError() throws {
        let files = try Fixtures.jsonFiles(in: "future")
        XCTAssertGreaterThanOrEqual(files.count, 3, "an unknown type, an extra field and a live event")
        // Live events have no id; LiveEventFixtureTests decodes them.
        for file in files where !file.lastPathComponent.hasPrefix("live-") {
            let name = file.lastPathComponent
            do {
                let event = try JSONDecoder().decode(Event.self, from: Data(contentsOf: file))
                let json = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any])
                let type = try XCTUnwrap(json["type"] as? String)
                if Self.knownTypes.contains(type) {
                    XCTAssertNotEqual(event.payload, .unknown(type: type), name)
                } else {
                    XCTAssertEqual(event.payload, .unknown(type: type), name)
                }
            } catch {
                XCTFail("\(name) does not decode: \(error)")
            }
        }
    }

    func testAnExtraFieldIsIgnored() throws {
        let file = Fixtures.directory.appending(path: "future/event-extra-field.json")
        let event = try JSONDecoder().decode(Event.self, from: Data(contentsOf: file))
        guard case let .messageCreated(message) = event.payload else {
            return XCTFail("expected a message.created event, got \(event.payload)")
        }
        XCTAssertEqual(message.id, "m1005")
        XCTAssertEqual(message.text, "好的。")
        XCTAssertEqual(message.runId, "k7m2qa")
    }
}

final class OpenValueTests: XCTestCase {
    func testUnknownValuesDecodeWithoutError() throws {
        let json = """
        {"id":11,"at":"2026-10-25T08:42:00Z","type":"message.created","data":{"id":"m1006","channel":"slack","direction":"sideways","text":"hi","files":[{"path":"inbox/a.bin","kind":"hologram"}],"at":"2026-10-25T08:42:00Z"}}
        """
        let event = try JSONDecoder().decode(Event.self, from: Data(json.utf8))
        guard case let .messageCreated(message) = event.payload else {
            return XCTFail("expected a message.created event, got \(event.payload)")
        }
        XCTAssertEqual(message.channel.rawValue, "slack")
        XCTAssertEqual(message.direction.rawValue, "sideways")
        XCTAssertEqual(message.files.first?.kind?.rawValue, "hologram")
    }

    func testUnknownRunKindAndStatusDecodeWithoutError() throws {
        let json = """
        {"id":12,"at":"2026-10-25T08:43:00Z","type":"run.updated","data":{"id":"k7m2qb","kind":"cron","title":"nightly","status":"paused","startedAt":"2026-10-25T08:43:00Z","costUsd":0,"files":[]}}
        """
        let event = try JSONDecoder().decode(Event.self, from: Data(json.utf8))
        guard case let .runUpdated(run) = event.payload else {
            return XCTFail("expected a run.updated event, got \(event.payload)")
        }
        XCTAssertEqual(run.kind.rawValue, "cron")
        XCTAssertEqual(run.status.rawValue, "paused")
    }

    func testTimestampsWithAndWithoutFractionalSecondsAgree() throws {
        let json = """
        {"id":13,"at":"2026-10-25T08:30:00Z","type":"future.thing","data":{}}
        """
        let plain = try JSONDecoder().decode(Event.self, from: Data(json.utf8))
        let fractional = try JSONDecoder().decode(
            Event.self,
            from: Data(json.replacingOccurrences(of: "08:30:00Z", with: "08:30:00.000Z").utf8)
        )
        XCTAssertEqual(plain.at, fractional.at)
        XCTAssertEqual(plain.at.timeIntervalSince1970, 1_792_917_000)
    }
}
