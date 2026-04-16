import Foundation
import Observation

/// An async sequence that yields deduplicated values from an `@Observable` property.
///
/// Unlike raw `AsyncStream`, this sequence responds to consuming-task cancellation:
/// when the task running `for await` is cancelled, `next()` returns `nil` promptly,
/// releasing all captured references (including the observed object). This prevents
/// leaks when the observed object is replaced (e.g., `rebuildClient()` swapping a
/// `GatewayConnectionManager`) while the old instance's property hasn't changed.
///
/// **Why this matters:** `AsyncStream<Value>.next()` (non-throwing) does NOT check
/// task cancellation — it only returns `nil` when `continuation.finish()` is called.
/// If the consuming task is cancelled while waiting on `next()`, the stream, its
/// internal observation `Task`, and all closure captures remain alive indefinitely
/// (until the observed property happens to change). This wrapper's `next()`
/// installs a `withTaskCancellationHandler` that calls `finish()` on the underlying
/// continuation, unblocking the pending `next()` and triggering full cleanup.
///
/// References:
/// - [AsyncStream cancellation limitation](https://forums.swift.org/t/critical-async-stream-cancellation-on-consuming-task/61562)
/// - [Observation framework](https://developer.apple.com/documentation/observation)
/// - [WWDC23 — Discover Observation in SwiftUI](https://developer.apple.com/videos/play/wwdc2023/10149/)
public struct ObservationValues<Value: Equatable & Sendable>: AsyncSequence, Sendable {
    public typealias Element = Value

    fileprivate let stream: AsyncStream<Value>
    fileprivate let finish: @Sendable () -> Void

    public func makeAsyncIterator() -> Iterator {
        Iterator(base: stream.makeAsyncIterator(), finish: finish)
    }

    public struct Iterator: AsyncIteratorProtocol {
        var base: AsyncStream<Value>.AsyncIterator
        let finish: @Sendable () -> Void

        public mutating func next() async -> Value? {
            guard !Task.isCancelled else {
                finish()
                return nil
            }
            return await withTaskCancellationHandler {
                await base.next()
            } onCancel: {
                finish()
            }
        }
    }
}

/// Creates a cancellation-cooperative async sequence that yields deduplicated values
/// from an `@Observable` property.
///
/// Usage:
/// ```swift
/// for await connected in observationStream({ manager.isConnected }) {
///     handleConnectionChange(connected)
/// }
/// ```
///
/// The sequence yields the current value immediately, then yields again each time
/// the tracked property changes to a different `Equatable` value. The internal
/// observation loop runs in an unstructured `Task` (non-isolated). In Swift 5
/// language mode this is safe because the Observation framework's registrar uses
/// internal locking. If the project migrates to Swift 6, the `getValue` closure
/// may need explicit `@MainActor` isolation.
///
/// **Cancellation:** When the consuming task is cancelled, `next()` returns `nil`
/// promptly, the `for await` loop exits, and all captured references are released.
/// See `ObservationValues` for details on why this is necessary.
///
/// - Parameter getValue: A closure that reads one or more `@Observable` properties.
///   Must be safe to call repeatedly on the caller's actor.
/// - Returns: An ``ObservationValues`` async sequence of deduplicated values.
public func observationStream<Value: Equatable & Sendable>(
    _ getValue: @Sendable @escaping () -> Value
) -> ObservationValues<Value> {
    // Shared box so `ObservationValues.Iterator.next()` can finish the continuation
    // from outside the stream when the consuming task is cancelled.
    let finisher = ContinuationFinisher()
    let stream = AsyncStream<Value> { continuation in
        finisher.setFinishAction { continuation.finish() }
        let initialValue = getValue()
        continuation.yield(initialValue)
        let task = Task {
            var lastValue = initialValue
            while !Task.isCancelled {
                let box = CancellableContinuationBox()
                await withTaskCancellationHandler {
                    await withCheckedContinuation { (resume: CheckedContinuation<Void, Never>) in
                        withObservationTracking {
                            _ = getValue()
                        } onChange: {
                            box.resume()
                        }
                        // If the value already changed between the initial read
                        // (or previous iteration) and tracking installation, wake
                        // immediately so the new value is not lost.
                        if getValue() != lastValue {
                            box.resume()
                        }
                        box.set(resume)
                    }
                } onCancel: {
                    box.resume()
                }
                guard !Task.isCancelled else { break }
                let newValue = getValue()
                if newValue != lastValue {
                    lastValue = newValue
                    continuation.yield(newValue)
                }
            }
            continuation.finish()
        }
        continuation.onTermination = { _ in
            task.cancel()
        }
    }
    return ObservationValues(stream: stream, finish: { finisher.finish() })
}

/// Thread-safe holder for a finish action that can be triggered externally.
/// Used by `ObservationValues.Iterator` to finish the underlying stream when
/// the consuming task is cancelled.
private final class ContinuationFinisher: @unchecked Sendable {
    private var finishAction: (() -> Void)?
    private var finished = false
    private let lock = NSLock()

    /// Store the finish action. Called once from the `AsyncStream` build closure.
    func setFinishAction(_ action: @escaping () -> Void) {
        lock.withLock {
            self.finishAction = action
        }
    }

    /// Finish the underlying stream. Idempotent and thread-safe.
    func finish() {
        let action: (() -> Void)? = lock.withLock {
            guard !finished else { return nil }
            finished = true
            let a = finishAction
            finishAction = nil
            return a
        }
        action?()
    }
}

/// Thread-safe one-shot box that pairs a `CheckedContinuation` with a resume
/// signal that may arrive before the continuation is stored (from `onChange` on
/// another thread) or after task cancellation (from `onCancel`).
public final class CancellableContinuationBox: @unchecked Sendable {
    private enum State {
        case empty
        case continuation(CheckedContinuation<Void, Never>)
        case resumed
    }

    private var state: State = .empty
    private let lock = NSLock()

    public init() {}

    /// Store the continuation. If `resume()` was already called (by `onChange`
    /// or `onCancel` racing ahead), resumes immediately.
    public func set(_ c: CheckedContinuation<Void, Never>) {
        let shouldResume: Bool = lock.withLock {
            switch state {
            case .empty:
                state = .continuation(c)
                return false
            case .resumed:
                return true
            case .continuation:
                preconditionFailure("CancellableContinuationBox.set called twice")
            }
        }
        if shouldResume { c.resume() }
    }

    /// Signal that the continuation should resume. Safe to call from any thread,
    /// and idempotent — only the first call has an effect.
    public func resume() {
        let c: CheckedContinuation<Void, Never>? = lock.withLock {
            switch state {
            case .empty:
                state = .resumed
                return nil
            case .continuation(let c):
                state = .resumed
                return c
            case .resumed:
                return nil
            }
        }
        c?.resume()
    }
}
