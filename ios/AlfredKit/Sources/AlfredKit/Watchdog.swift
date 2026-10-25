import Synchronization

/// Cancels the read it supervises when `limit` passes without a `touch`. Each touch re-arms the countdown.
/// `run` reads until the read ends, and returns normally when the watchdog has stopped it.
final class Watchdog: Sendable {
    private let limit: Duration
    private let sleep: @Sendable (Duration) async throws -> Void
    private let timer = Mutex<Task<Void, Never>?>(nil)
    private let running = Mutex<Task<Void, Error>?>(nil)
    private let fired = Mutex(false)

    init(limit: Duration, sleep: @escaping @Sendable (Duration) async throws -> Void) {
        self.limit = limit
        self.sleep = sleep
    }

    var hasFired: Bool {
        fired.withLock { $0 }
    }

    /// Runs `work` until it ends. The countdown starts now; `work` calls `touch` as input arrives.
    func run(_ work: @escaping @Sendable () async throws -> Void) async throws {
        let task = Task { try await work() }
        running.withLock { $0 = task }
        touch()
        defer { stop() }
        do {
            try await withTaskCancellationHandler {
                try await task.value
            } onCancel: {
                task.cancel()
            }
        } catch {
            if Task.isCancelled || !hasFired { throw error }
        }
    }

    /// Restarts the countdown.
    func touch() {
        let countdown = Task { [self] in
            do {
                try await sleep(limit)
            } catch {
                return
            }
            guard !Task.isCancelled else { return }
            fired.withLock { $0 = true }
            running.withLock { $0?.cancel() }
        }
        timer.withLock { previous in
            previous?.cancel()
            previous = countdown
        }
    }

    private func stop() {
        timer.withLock { current in
            current?.cancel()
            current = nil
        }
    }
}
