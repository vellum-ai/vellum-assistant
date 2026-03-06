import Foundation

/// Limits concurrent async operations to a fixed number of slots.
///
/// Used by `ImageMIMEProbe` to cap in-flight HTTP HEAD requests so that
/// a burst of extensionless URLs (e.g. many messages scrolling into view)
/// doesn't saturate the network.
private actor AsyncSemaphore {
    private var count: Int
    private var nextID: UInt64 = 0
    private var waiters: [(id: UInt64, continuation: CheckedContinuation<Void, Never>)] = []

    init(value: Int) { self.count = value }

    /// Waits for a slot. If the calling task is cancelled while waiting,
    /// the waiter is removed from the queue so it doesn't occupy a slot.
    func wait() async throws {
        if count > 0 {
            count -= 1
            return
        }
        let id = nextID
        nextID += 1
        try await withTaskCancellationHandler {
            await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                waiters.append((id: id, continuation: continuation))
            }
        } onCancel: {
            Task { await self.cancelWaiter(id: id) }
        }
        // After resuming, re-check cancellation so cancelled tasks don't proceed.
        try Task.checkCancellation()
    }

    /// Removes a cancelled waiter and restores the slot it would have used.
    /// If the waiter was already removed by signal() (race between cancel and
    /// signal), return the slot that signal() transferred to the now-cancelled task.
    private func cancelWaiter(id: UInt64) {
        if let idx = waiters.firstIndex(where: { $0.id == id }) {
            let removed = waiters.remove(at: idx)
            removed.continuation.resume()
        } else {
            // signal() already resumed this waiter and gave it a slot,
            // but the task is cancelled and won't use it. Return the slot.
            count += 1
        }
    }

    func signal() {
        if let waiter = waiters.first {
            waiters.removeFirst()
            waiter.continuation.resume()
        } else {
            count += 1
        }
    }
}

/// Probes URLs via HTTP HEAD to determine whether they serve image content.
///
/// This is the second stage of image detection, used for extensionless URLs
/// that `ImageURLClassifier` returns `.unknown` for. Results are cached
/// in-memory to avoid redundant network requests.
public final class ImageMIMEProbe {
    public static let shared = ImageMIMEProbe()

    private let cache = NSCache<NSString, CacheEntry>()
    private let session: URLSession
    private let semaphore = AsyncSemaphore(value: 4)

    /// Wraps the classification value so it can be stored in `NSCache`.
    private class CacheEntry: NSObject {
        let value: ImageURLClassification
        init(_ value: ImageURLClassification) {
            self.value = value
        }
    }

    init(session: URLSession = .shared) {
        self.session = session
        cache.countLimit = 500
    }

    /// Sends an HTTP HEAD request and classifies the response content type.
    ///
    /// Returns `.image` when the Content-Type starts with `image/`,
    /// `.notImage` for any other content type, and `.unknown` on
    /// network errors or timeouts. Never throws.
    public func probe(_ url: URL) async -> ImageURLClassification {
        guard url.scheme?.lowercased() == "https" else {
            return .notImage
        }

        let key = url.absoluteString as NSString

        if let cached = cache.object(forKey: key) {
            return cached.value
        }

        var request = URLRequest(url: url)
        request.httpMethod = "HEAD"
        request.timeoutInterval = 5

        do {
            try await semaphore.wait()
        } catch {
            return .unknown  // Task was cancelled while waiting for a slot
        }
        defer { Task { await semaphore.signal() } }

        let result: ImageURLClassification
        do {
            let (_, response) = try await session.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse,
                  let contentType = httpResponse.value(forHTTPHeaderField: "Content-Type")?.lowercased()
            else {
                result = .unknown
                cache.setObject(CacheEntry(result), forKey: key)
                return result
            }
            result = contentType.hasPrefix("image/") ? .image : .notImage
        } catch {
            return .unknown  // Don't cache — allow retry on transient failures
        }

        cache.setObject(CacheEntry(result), forKey: key)
        return result
    }

    public func clearCache() {
        cache.removeAllObjects()
    }
}
