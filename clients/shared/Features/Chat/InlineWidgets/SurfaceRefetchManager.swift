import Foundation
import os

private let log = Logger(
    subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant",
    category: "SurfaceRefetchManager"
)

/// Serializes surface content fetches so only one request is in flight at a time.
/// Queued requests are processed in FIFO order. Duplicate requests for the same
/// surface ID are coalesced — all callers waiting for the same surface receive
/// the result once the single fetch completes.
public actor SurfaceRefetchManager {
    public typealias FetchBlock = (String, String) async -> SurfaceData?

    private let fetch: FetchBlock

    /// FIFO queue of surfaces awaiting fetch.
    private var queue: [(surfaceId: String, sessionId: String)] = []

    /// Continuations for callers waiting on a specific surface's result.
    private var waiters: [String: [CheckedContinuation<SurfaceData?, Never>]] = [:]

    /// Whether the serial processing loop is currently active.
    private var isProcessing = false

    public init(fetch: @escaping FetchBlock) {
        self.fetch = fetch
    }

    /// Enqueue a surface for re-fetch. Suspends the caller until the fetch
    /// completes and returns the resulting `SurfaceData`, or `nil` on failure.
    /// Duplicate requests for the same surface ID are coalesced so only one
    /// network request is made.
    @discardableResult
    public func enqueue(surfaceId: String, sessionId: String) async -> SurfaceData? {
        return await withCheckedContinuation { continuation in
            if waiters[surfaceId] != nil {
                waiters[surfaceId]?.append(continuation)
                return
            }

            waiters[surfaceId] = [continuation]
            queue.append((surfaceId: surfaceId, sessionId: sessionId))

            if !isProcessing {
                isProcessing = true
                Task { await self.processQueue() }
            }
        }
    }

    /// Remove a pending surface from the queue and resume its waiters with `nil`.
    public func cancel(surfaceId: String) {
        queue.removeAll(where: { $0.surfaceId == surfaceId })
        resumeWaiters(for: surfaceId, with: nil)
    }

    // MARK: - Internal

    /// Drains the queue one item at a time, fetching each surface serially.
    private func processQueue() async {
        defer { isProcessing = false }

        while let next = queue.first {
            queue.removeFirst()
            log.info("Fetching surface content: \(next.surfaceId)")
            let data = await fetch(next.surfaceId, next.sessionId)
            resumeWaiters(for: next.surfaceId, with: data)
        }
    }

    /// Resume all continuations waiting for a given surface ID.
    private func resumeWaiters(for surfaceId: String, with data: SurfaceData?) {
        guard let continuations = waiters.removeValue(forKey: surfaceId) else { return }
        for continuation in continuations {
            continuation.resume(returning: data)
        }
    }
}
