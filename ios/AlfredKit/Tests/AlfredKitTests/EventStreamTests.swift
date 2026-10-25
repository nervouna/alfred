import AlfredKit
import Foundation
import Synchronization
import XCTest

/// The sleeps of the stream's tests. Backoff sleeps return at once. A watchdog sleep (75 s) waits until the test
/// fires it, or until the stream cancels it, so each test decides when a connection goes quiet.
actor FakeSleep {
    private(set) var durations: [Duration] = []
    private var waiting: [Int: CheckedContinuation<Void, Error>] = [:]
    private var pendingIDs: [Int] = []
    private var nextID = 0

    func sleep(_ duration: Duration) async throws {
        durations.append(duration)
        guard duration == .seconds(75) else { return }
        let id = nextID
        nextID += 1
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                waiting[id] = continuation
                pendingIDs.append(id)
            }
        } onCancel: {
            Task { await self.cancel(id) }
        }
    }

    /// Lets the oldest pending watchdog finish, which is the watchdog firing.
    func fireWatchdog() {
        guard !pendingIDs.isEmpty else { return }
        let id = pendingIDs.removeFirst()
        waiting.removeValue(forKey: id)?.resume()
    }

    var pendingWatchdogs: Int {
        pendingIDs.count
    }

    var watchdogRequests: Int {
        durations.filter { $0 == .seconds(75) }.count
    }

    /// Every sleep that was not a watchdog, in order: the backoff.
    var backoffs: [Duration] {
        durations.filter { $0 != .seconds(75) }
    }

    private func cancel(_ id: Int) {
        pendingIDs.removeAll { $0 == id }
        waiting.removeValue(forKey: id)?.resume(throwing: CancellationError())
    }
}

/// Replies to the stream's requests in turn. Once the replies run out, requests get a 500.
final class Script: Sendable {
    private let replies: Mutex<[StubReply]>

    init(_ replies: [StubReply]) {
        self.replies = Mutex(replies)
    }

    func next() -> StubReply {
        replies.withLock { $0.isEmpty ? StubReply(status: 500) : $0.removeFirst() }
    }
}

/// The updates a consumer has seen so far, and whether the stream has finished.
final class UpdateLog: Sendable {
    private struct State {
        var updates: [EventStreamUpdate] = []
        var finished = false
    }

    private let state = Mutex(State())

    func append(_ update: EventStreamUpdate) {
        state.withLock { $0.updates.append(update) }
    }

    func finish() {
        state.withLock { $0.finished = true }
    }

    var all: [EventStreamUpdate] {
        state.withLock { $0.updates }
    }

    var isFinished: Bool {
        state.withLock { $0.finished }
    }
}

/// One frame as the server writes it: an id line for a stored event, none for a live one.
func frame(_ path: String) throws -> Data {
    let json = try JSONSerialization.jsonObject(with: fixture(path))
    let line = String(decoding: try JSONSerialization.data(withJSONObject: json, options: [.sortedKeys]), as: UTF8.self)
    var text = ""
    if let object = json as? [String: Any], let id = object["id"] as? Int {
        text += "id: \(id)\n"
    }
    return Data((text + "data: \(line)\n\n").utf8)
}

/// The stream event a fixture holds.
func streamEvent(_ path: String) throws -> StreamEvent {
    try JSONDecoder().decode(StreamEvent.self, from: fixture(path))
}

/// Polls until `condition` holds. Polling only waits for URLSession's callbacks: backoff and watchdog time come
/// from `FakeSleep`, not from the clock.
func eventually(
    file: StaticString = #filePath,
    line: UInt = #line,
    _ condition: @escaping @Sendable () async -> Bool
) async {
    for _ in 0..<5000 {
        if await condition() { return }
        try? await Task.sleep(for: .milliseconds(1))
    }
    XCTFail("the condition never held", file: file, line: line)
}

final class EventStreamTests: XCTestCase {
    /// A stream whose requests are answered by `replies`, with its sleeps and requests recorded.
    private func makeStream(_ replies: [StubReply], sleep: FakeSleep, log: RequestLog) throws -> EventStream {
        let script = Script(replies.map { reply in
            var reply = reply
            if reply.status == 200 { reply.headers["Content-Type"] = "text/event-stream" }
            return reply
        })
        let client = try stubbedClient { request in
            log.record(request)
            return script.next()
        }
        return EventStream(client: client, sleep: { try await sleep.sleep($0) })
    }

    /// Consumes the stream's updates into `log` until the stream finishes. The consumer is cancelled when the test
    /// ends, so a test that fails early does not leave a stream reconnecting behind it.
    private func consume(_ stream: EventStream, into log: UpdateLog) -> Task<Void, Never> {
        let task = Task {
            for await update in await stream.updates() {
                log.append(update)
            }
            log.finish()
        }
        addTeardownBlock { task.cancel() }
        return task
    }

    func testAReconnectResumesAfterTheLastStoredIDAndLiveEventsDoNotMoveIt() async throws {
        let sleep = FakeSleep()
        let log = RequestLog()
        let stream = try makeStream([
            StubReply(chunks: [
                try frame("events/message-created-app-in.json"),
                try frame("events/run-updated-running.json"),
                try frame("live/message-delta.json"),
            ]),
            StubReply(chunks: [try frame("events/message-created-app-out.json")]),
        ], sleep: sleep, log: log)
        let updates = UpdateLog()
        let task = consume(stream, into: updates)
        await eventually { updates.all.count >= 7 }
        task.cancel()
        await task.value

        XCTAssertEqual(Array(updates.all.prefix(7)), [
            .connected,
            .received(try streamEvent("events/message-created-app-in.json")),
            .received(try streamEvent("events/run-updated-running.json")),
            .received(try streamEvent("live/message-delta.json")),
            .disconnected,
            .connected,
            .received(try streamEvent("events/message-created-app-out.json")),
        ])
        let first = try XCTUnwrap(log.entries.first)
        let second = try XCTUnwrap(log.entries.dropFirst().first)
        XCTAssertEqual(first.request.value(forHTTPHeaderField: "Last-Event-ID"), "0")
        XCTAssertEqual(second.request.value(forHTTPHeaderField: "Last-Event-ID"), "2")
        XCTAssertEqual(second.request.value(forHTTPHeaderField: "Accept"), "text/event-stream")
        XCTAssertEqual(try encodedPath(second.request), "/api/events")
        assertCredentials(second.request)
    }

    func testRetriesWaitOneTwoFourEightAndSixteenSecondsThenThirty() async throws {
        let sleep = FakeSleep()
        let stream = try makeStream(Array(repeating: StubReply(status: 500), count: 8), sleep: sleep, log: RequestLog())
        let task = consume(stream, into: UpdateLog())
        await eventually { await sleep.backoffs.count >= 7 }
        task.cancel()
        await task.value
        let backoffs = await sleep.backoffs
        XCTAssertEqual(Array(backoffs.prefix(7)), [
            .seconds(1), .seconds(2), .seconds(4), .seconds(8), .seconds(16), .seconds(30), .seconds(30),
        ])
    }

    func testAConnectionThatDeliveredRestartsTheBackoff() async throws {
        let sleep = FakeSleep()
        let stream = try makeStream([
            StubReply(status: 500),
            StubReply(status: 500),
            StubReply(chunks: [try frame("events/message-created-app-in.json")]),
            StubReply(status: 500),
            StubReply(status: 500),
        ], sleep: sleep, log: RequestLog())
        let task = consume(stream, into: UpdateLog())
        await eventually { await sleep.backoffs.count >= 4 }
        task.cancel()
        await task.value
        let backoffs = await sleep.backoffs
        XCTAssertEqual(Array(backoffs.prefix(4)), [.seconds(1), .seconds(2), .seconds(1), .seconds(2)])
    }

    func testAConnectionThatGoesQuietIsDroppedWhenTheWatchdogFires() async throws {
        let sleep = FakeSleep()
        let log = RequestLog()
        let stream = try makeStream([
            StubReply(chunks: [Data(": ping\n\n".utf8)], finish: false),
            StubReply(chunks: [try frame("events/message-created-app-in.json")]),
        ], sleep: sleep, log: log)
        let updates = UpdateLog()
        let task = consume(stream, into: updates)

        // The countdown is armed when the connection opens and armed again by the ping: two watchdog sleeps,
        // of which the first was cancelled. Nothing has dropped the connection yet. The consumer has to have
        // taken the update off the stream, which is not ordered against the sleeps.
        await eventually {
            let requests = await sleep.watchdogRequests
            let pending = await sleep.pendingWatchdogs
            return requests == 2 && pending == 1 && updates.all.count >= 1
        }
        XCTAssertEqual(updates.all, [.connected])

        await sleep.fireWatchdog()
        await eventually { updates.all.count >= 4 }
        XCTAssertEqual(Array(updates.all.prefix(4)), [
            .connected,
            .disconnected,
            .connected,
            .received(try streamEvent("events/message-created-app-in.json")),
        ])
        let reconnect = try XCTUnwrap(log.entries.dropFirst().first)
        XCTAssertEqual(reconnect.request.value(forHTTPHeaderField: "Last-Event-ID"), "0")
        task.cancel()
        await task.value
    }

    func testAnAccessErrorStopsTheStreamWithoutARetry() async throws {
        for status in [401, 403] {
            let sleep = FakeSleep()
            let log = RequestLog()
            let stream = try makeStream([StubReply(status: status)], sleep: sleep, log: log)
            let updates = UpdateLog()
            let task = consume(stream, into: updates)
            await eventually { updates.isFinished }
            await task.value
            let expected: AlfredError = status == 401 ? .unauthorized : .forbidden
            XCTAssertEqual(updates.all, [.stopped(expected)], "status \(status)")
            XCTAssertEqual(log.entries.count, 1, "status \(status) is not retried")
            let backoffs = await sleep.backoffs
            XCTAssertEqual(backoffs, [], "status \(status) waits for nothing")
        }
    }

    func testAFrameThatDoesNotDecodeIsSkippedAndItsIDIsStillResumedPast() async throws {
        let sleep = FakeSleep()
        let log = RequestLog()
        let stream = try makeStream([
            StubReply(chunks: [
                try frame("events/message-created-app-in.json"),
                Data("id: 2\ndata: {not json\n\n".utf8),
            ]),
            StubReply(status: 500),
        ], sleep: sleep, log: log)
        let updates = UpdateLog()
        let task = consume(stream, into: updates)
        await eventually { updates.all.count >= 4 }
        task.cancel()
        await task.value
        // The reconnect is refused with a 500, so it reports a failed connection and never connects.
        XCTAssertEqual(Array(updates.all.prefix(4)), [
            .connected,
            .received(try streamEvent("events/message-created-app-in.json")),
            .disconnected,
            .disconnected,
        ])
        let reconnect = try XCTUnwrap(log.entries.dropFirst().first)
        XCTAssertEqual(reconnect.request.value(forHTTPHeaderField: "Last-Event-ID"), "2")
    }

    func testCancellingTheConsumerStopsTheStream() async throws {
        let sleep = FakeSleep()
        let log = RequestLog()
        let stream = try makeStream([
            StubReply(chunks: [Data(": ping\n\n".utf8)], finish: false),
        ], sleep: sleep, log: log)
        let updates = UpdateLog()
        let task = consume(stream, into: updates)
        // The countdown is armed when the connection opens and armed again by the ping; the first was cancelled.
        // The consumer has to have logged the connection before the cancel: a cancelled consumer may leave
        // what is still on the stream untaken.
        await eventually {
            let requests = await sleep.watchdogRequests
            let pending = await sleep.pendingWatchdogs
            return requests == 2 && pending == 1 && updates.all.count >= 1
        }

        task.cancel()
        await task.value
        await eventually { await sleep.pendingWatchdogs == 0 }
        XCTAssertTrue(updates.isFinished)
        XCTAssertEqual(log.entries.count, 1, "no reconnect after the consumer is gone")
        XCTAssertEqual(updates.all, [.connected])
    }
}
