/// Binds selection retries to the application and key hold that started them.
public struct SelectionReadSession {
    private var generation = 0
    private var processId: Int32?

    public init() {}

    public mutating func begin(processId: Int32?) {
        generation += 1
        self.processId = processId
    }

    public mutating func end() {
        processId = nil
    }

    public func token(processId: Int32?, expected: Int?) -> Int? {
        guard let processId, processId == self.processId,
              expected == nil || expected == generation else { return nil }
        return generation
    }

    /// Focus and selected text can become available at different times during Chromium warmup.
    public static func unavailableResult(holdId: Int, trusted: Bool, chromium: Bool) -> [String: Any] {
        var result: [String: Any] = ["unavailable": true]
        if trusted && chromium {
            result["holdId"] = holdId
        }
        return result
    }
}
