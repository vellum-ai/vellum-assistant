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
            await withCheckedContinuation { (resume: CheckedContinuation<Void, Never>) in
                withObservationTracking {
                    _ = getValue()
                } onChange: {
                    resume.resume()
                }
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
