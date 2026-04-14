import Foundation
import Observation

/// Creates an `AsyncStream` that yields deduplicated values from an `@Observable` property.
///
/// Usage:
/// ```swift
/// for await connected in observationStream({ manager.isConnected }) {
///     handleConnectionChange(connected)
/// }
/// ```
///
/// The stream yields the current value immediately, then yields again each time
/// the tracked property changes to a different `Equatable` value. The internal
/// observation loop runs in an unstructured `Task` (non-isolated). In Swift 5
/// language mode this is safe because the Observation framework's registrar uses
/// internal locking. If the project migrates to Swift 6, the `getValue` closure
/// may need explicit `@MainActor` isolation.
///
/// - Parameter getValue: A closure that reads one or more `@Observable` properties.
///   Must be safe to call repeatedly on the caller's actor.
/// - Returns: An `AsyncStream` of deduplicated values.
///
/// References:
/// - [Observation framework](https://developer.apple.com/documentation/observation)
/// - [WWDC23 — Discover Observation in SwiftUI](https://developer.apple.com/videos/play/wwdc2023/10149/)
public func observationStream<Value: Equatable & Sendable>(
    _ getValue: @Sendable @escaping () -> Value
) -> AsyncStream<Value> {
    let (stream, continuation) = AsyncStream.makeStream(of: Value.self)
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
    return stream
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
