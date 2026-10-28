import Foundation

/// What an event stream reports: a connection coming up or going down, the stream events, and the stop on an access
/// error (401 or 403), after which the stream does not retry. A connection's events arrive in two parts: the backlog
/// as one `backlog`, then each later event as it happens as a `received`.
public enum EventStreamUpdate: Hashable, Sendable {
    case connected
    /// Everything the server had when the connection came up, in order, so the app can apply it in one piece. It is
    /// empty when there was nothing to catch up on. A connection that ends before the server said the backlog was
    /// complete reports what it got as a `backlog` before its `disconnected`, unless that was nothing.
    case backlog([StreamEvent])
    case received(StreamEvent)
    case disconnected
    case stopped(AlfredError)
}

/// Follows `/api/events` from an event id. It reconnects after a drop, resuming with `Last-Event-ID`, waiting 1, 2, 4 ...
/// seconds up to 30 between attempts (the wait starts over after a connection that delivered an event). A connection
/// that stays silent for 75 s, with no frame and no ping, is dropped. A 401 or 403 stops the stream.
///
/// The server ends the backlog of a connection with a `caught-up` frame (no id), once per connection. Until it comes,
/// the events are held back; a server that does not send it keeps them until the connection ends.
///
/// Time comes in through `sleep`, which both the waits and the watchdog use; the default is `Task.sleep`. Call
/// `updates()` once. Cancelling the task that consumes the updates stops the stream.
public actor EventStream {
    static let initialDelay = Duration.seconds(1)
    static let maxDelay = Duration.seconds(30)
    static let idleLimit = Duration.seconds(75)
    /// The name of the frame that ends a backlog.
    static let caughtUpEvent = "caught-up"

    private let client: AlfredClient
    private let sleep: @Sendable (Duration) async throws -> Void
    private var lastEventId: Int64
    /// Whether the current connection has delivered a stream event.
    private var productive = false
    /// Whether the current connection has seen the `caught-up` frame.
    private var caughtUp = false
    /// The events the current connection has read since it came up, held until the `caught-up` frame.
    private var backlog: [StreamEvent] = []

    public init(
        client: AlfredClient,
        after lastEventId: Int64 = 0,
        sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) }
    ) {
        self.client = client
        self.lastEventId = lastEventId
        self.sleep = sleep
    }

    /// The updates, starting with the first connection.
    public func updates() -> AsyncStream<EventStreamUpdate> {
        AsyncStream { continuation in
            let task = Task { await self.run(continuation) }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    private func run(_ continuation: AsyncStream<EventStreamUpdate>.Continuation) async {
        var wait = Self.initialDelay
        while !Task.isCancelled {
            do {
                try await connect(continuation)
            } catch let error as AlfredError where error == .unauthorized || error == .forbidden {
                continuation.yield(.stopped(error))
                break
            } catch {
                // A connection that failed is retried like one that dropped.
            }
            if Task.isCancelled { break }
            continuation.yield(.disconnected)
            if productive { wait = Self.initialDelay }
            do {
                try await sleep(wait)
            } catch {
                break
            }
            wait = min(wait * 2, Self.maxDelay)
        }
        continuation.finish()
    }

    /// One connection, read to its end. Returns normally when the server closes it or the watchdog drops it.
    private func connect(_ continuation: AsyncStream<EventStreamUpdate>.Continuation) async throws {
        productive = false
        caughtUp = false
        backlog = []
        // However the connection ends, what it held back goes out before the caller reports the drop. The resume
        // point has moved past those events, so the next connection would not send them again.
        defer {
            if !caughtUp, !backlog.isEmpty { continuation.yield(.backlog(backlog)) }
            backlog = []
        }
        let bytes = try await client.events(after: lastEventId)
        continuation.yield(.connected)
        let watchdog = Watchdog(limit: Self.idleLimit, sleep: sleep)
        try await watchdog.run { try await self.read(bytes, continuation, watchdog) }
    }

    /// Reads frames from the bytes. Every item, heartbeats included, keeps the watchdog from firing.
    private func read(
        _ bytes: URLSession.AsyncBytes,
        _ continuation: AsyncStream<EventStreamUpdate>.Continuation,
        _ watchdog: Watchdog
    ) async throws {
        var parser = SSEParser()
        for try await byte in bytes {
            guard let item = parser.feed(byte) else { continue }
            watchdog.touch()
            guard case let .frame(frame) = item else { continue }
            // Only a frame with an id moves the resume point, and that holds for one that does not decode too.
            if let id = frame.id.flatMap({ Int64($0) }) {
                lastEventId = max(lastEventId, id)
            }
            if frame.event == Self.caughtUpEvent {
                if !caughtUp {
                    caughtUp = true
                    continuation.yield(.backlog(backlog))
                    backlog = []
                }
                continue
            }
            guard let event = try? JSONDecoder().decode(StreamEvent.self, from: Data(frame.data.utf8)) else { continue }
            productive = true
            if caughtUp {
                continuation.yield(.received(event))
            } else {
                backlog.append(event)
            }
        }
    }
}
