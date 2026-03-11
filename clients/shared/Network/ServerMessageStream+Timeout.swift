import Foundation

extension AsyncStream where Element == ServerMessage {

    /// Race a stream listener against a timeout (default 15 seconds).
    ///
    /// The `extract` closure inspects each incoming message:
    /// - Return a value to resolve the race.
    /// - Return `nil` to skip and keep listening.
    ///
    /// Returns `nil` when the timeout fires first or the stream ends
    /// without a match.
    func firstMatch<T: Sendable>(
        timeout: UInt64 = 15_000_000_000,
        extract: @Sendable @escaping (ServerMessage) -> T?
    ) async -> T? {
        await withTaskGroup(of: T?.self) { group in
            group.addTask {
                for await message in self {
                    if let value = extract(message) { return value }
                }
                return nil
            }
            group.addTask {
                try? await Task.sleep(nanoseconds: timeout)
                return nil
            }
            let first = await group.next() ?? nil
            group.cancelAll()
            return first
        }
    }
}
