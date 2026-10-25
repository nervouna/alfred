import Foundation

/// What an event stream reports: a connection coming up or going down, each stream event as it arrives, and the
/// stop on an access error (401 or 403), after which the stream does not retry.
public enum EventStreamUpdate: Hashable, Sendable {
    case connected
    case received(StreamEvent)
    case disconnected
    case stopped(AlfredError)
}

/// Follows `/api/events` from an event id. It reconnects after a drop, resuming with `Last-Event-ID`, waiting 1, 2, 4 ...
/// seconds up to 30 between attempts (the wait starts over after a connection that delivered an event). A connection
/// that stays silent for 75 s, with no frame and no ping, is dropped. A 401 or 403 stops the stream.
///
/// Time comes in through `sleep`, which both the waits and the watchdog use; the default is `Task.sleep`. Call
/// `updates()` once. Cancelling the task that consumes the updates stops the stream.
public actor EventStream {
    static let initialDelay = Duration.seconds(1)
    static let maxDelay = Duration.seconds(30)
    static let idleLimit = Duration.seconds(75)

    private let client: AlfredClient
    private let sleep: @Sendable (Duration) async throws -> Void
    private var lastEventId: Int64
    /// Whether the current connection has delivered a stream event.
    private var productive = false

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
            guard let event = try? JSONDecoder().decode(StreamEvent.self, from: Data(frame.data.utf8)) else { continue }
            productive = true
            continuation.yield(.received(event))
        }
    }
}
