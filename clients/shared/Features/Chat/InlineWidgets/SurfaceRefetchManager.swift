import Foundation
import os

private let log = Logger(
    subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant",
    category: "SurfaceRefetchManager"
)

/// Serializes surface content fetches so only one request is in flight at a time.
/// Queued requests are processed in FIFO order. Duplicate requests for the same
/// surface ID are coalesced — only the first enqueue triggers a fetch.
public actor SurfaceRefetchManager {
    public typealias FetchBlock = (String, String) async -> SurfaceData?

    private let fetch: FetchBlock
    private var queue: [(surfaceId: String, sessionId: String)] = []
    private var inFlight: String?
    private var processing = false

    public init(fetch: @escaping FetchBlock) {
        self.fetch = fetch
    }

    /// Enqueue a surface for re-fetch. Returns the fetched `SurfaceData` or `nil`
    /// if the fetch failed or was already in flight for this surface.
    @discardableResult
    public func enqueue(surfaceId: String, sessionId: String) async -> SurfaceData? {
        guard inFlight != surfaceId, !queue.contains(where: { $0.surfaceId == surfaceId }) else {
            return nil
        }
        queue.append((surfaceId: surfaceId, sessionId: sessionId))
        return await processNext(targetSurfaceId: surfaceId)
    }

    /// Cancel any pending fetch for the given surface ID.
    public func cancel(surfaceId: String) {
        queue.removeAll(where: { $0.surfaceId == surfaceId })
    }

    // MARK: - Internal

    private func processNext(targetSurfaceId: String) async -> SurfaceData? {
        guard !processing else {
            // Another call is already driving the queue; wait for our turn via polling.
            return await waitForResult(surfaceId: targetSurfaceId)
        }
        processing = true
        defer { processing = false }

        var lastResult: (surfaceId: String, data: SurfaceData?)? = nil

        while let next = queue.first {
            queue.removeFirst()
            inFlight = next.surfaceId
            log.info("Fetching surface content: \(next.surfaceId)")
            let data = await fetch(next.surfaceId, next.sessionId)
            lastResult = (next.surfaceId, data)
            inFlight = nil

            if next.surfaceId == targetSurfaceId {
                // Drain the rest in the background after returning.
                if !queue.isEmpty {
                    Task { await self.drainRemaining() }
                }
                return data
            }
        }
        // The target was processed as part of the queue scan.
        if lastResult?.surfaceId == targetSurfaceId {
            return lastResult?.data
        }
        return nil
    }

    private func drainRemaining() async {
        guard !processing else { return }
        processing = true
        defer { processing = false }

        while let next = queue.first {
            queue.removeFirst()
            inFlight = next.surfaceId
            log.info("Fetching surface content (drain): \(next.surfaceId)")
            _ = await fetch(next.surfaceId, next.sessionId)
            inFlight = nil
        }
    }

    private func waitForResult(surfaceId: String) async -> SurfaceData? {
        // Yield repeatedly until our surface is no longer queued/in-flight,
        // meaning it has been processed by the driving loop.
        for _ in 0..<300 {
            if inFlight != surfaceId, !queue.contains(where: { $0.surfaceId == surfaceId }) {
                return nil
            }
            try? await Task.sleep(nanoseconds: 50_000_000) // 50ms
        }
        return nil
    }
}
