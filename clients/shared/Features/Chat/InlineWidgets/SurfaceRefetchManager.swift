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

    private static let maxRetries = 3

    private let fetch: FetchBlock

    /// FIFO queue of surfaces awaiting fetch.
    private var queue: [(surfaceId: String, conversationId: String)] = []

    /// Result returned by `enqueue`, allowing callers to distinguish between
    /// a transient failure (retry later) and a permanent failure (retries exhausted).
    public struct RefetchResult: Sendable {
        public let data: SurfaceData?
        public let retriesExhausted: Bool
    }

    /// Continuations for callers waiting on a specific surface's result.
    private var waiters: [String: [CheckedContinuation<RefetchResult, Never>]] = [:]

    /// Whether the serial processing loop is currently active.
    private var isProcessing = false

    /// Tracks consecutive failure count per surface to cap retries.
    private var failureCount: [String: Int] = [:]

    public init(fetch: @escaping FetchBlock) {
        self.fetch = fetch
    }

    /// Enqueue a surface for re-fetch. Suspends the caller until the fetch
    /// completes and returns a `RefetchResult` indicating success/failure and
    /// whether the maximum retry count has been reached. Duplicate requests
    /// for the same surface ID are coalesced so only one network request is
    /// made. Returns immediately with `retriesExhausted: true` if the surface
    /// has already exceeded the maximum retry count.
    @discardableResult
    public func enqueue(surfaceId: String, conversationId: String) async -> RefetchResult {
        if (failureCount[surfaceId] ?? 0) >= Self.maxRetries {
            log.info("Skipping refetch for \(surfaceId): exceeded \(Self.maxRetries) retries")
            return RefetchResult(data: nil, retriesExhausted: true)
        }

        return await withCheckedContinuation { continuation in
            if waiters[surfaceId] != nil {
                waiters[surfaceId]?.append(continuation)
                return
            }

            waiters[surfaceId] = [continuation]
            queue.append((surfaceId: surfaceId, conversationId: conversationId))

            if !isProcessing {
                isProcessing = true
                Task { await self.processQueue() }
            }
        }
    }

    /// Remove a pending surface from the queue and resume its waiters with a cancelled result.
    public func cancel(surfaceId: String) {
        queue.removeAll(where: { $0.surfaceId == surfaceId })
        resumeWaiters(for: surfaceId, with: RefetchResult(data: nil, retriesExhausted: false))
    }

    /// Clear all tracked failure counts so previously-blocked surfaces can be retried.
    /// Call when the session changes or the message list is replaced.
    public func resetFailureCounts() {
        failureCount.removeAll()
    }

    // MARK: - Internal

    /// Drains the queue one item at a time, fetching each surface serially.
    private func processQueue() async {
        defer { isProcessing = false }

        while let next = queue.first {
            queue.removeFirst()
            log.info("Fetching surface content: \(next.surfaceId)")
            let data = await fetch(next.surfaceId, next.conversationId)
            if data != nil {
                failureCount.removeValue(forKey: next.surfaceId)
            } else {
                failureCount[next.surfaceId, default: 0] += 1
            }
            let exhausted = (failureCount[next.surfaceId] ?? 0) >= Self.maxRetries
            resumeWaiters(for: next.surfaceId, with: RefetchResult(data: data, retriesExhausted: exhausted))
        }
    }

    /// Resume all continuations waiting for a given surface ID.
    private func resumeWaiters(for surfaceId: String, with result: RefetchResult) {
        guard let continuations = waiters.removeValue(forKey: surfaceId) else { return }
        for continuation in continuations {
            continuation.resume(returning: result)
        }
    }
}
