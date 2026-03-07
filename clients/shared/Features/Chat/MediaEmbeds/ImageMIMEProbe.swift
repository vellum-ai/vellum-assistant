import Foundation

/// Limits concurrent async operations to a fixed number of slots.
///
/// Used by `ImageMIMEProbe` to cap in-flight HTTP HEAD requests so that
/// a burst of extensionless URLs (e.g. many messages scrolling into view)
/// doesn't saturate the network.
private actor AsyncSemaphore {
    private var count: Int
    private var nextID: UInt64 = 0
    private var waiters: [(id: UInt64, continuation: CheckedContinuation<Bool, Never>)] = []

    init(value: Int) { self.count = value }

    /// Waits for a slot. Returns `true` if a slot was acquired, `false` if the
    /// task was cancelled while waiting (no slot consumed). The caller must only
    /// call `signal()` when this returns `true`.
    func wait() async -> Bool {
        if count > 0 {
            count -= 1
            return true
        }
        let id = nextID
        nextID += 1
        let acquired = await withTaskCancellationHandler {
            await withCheckedContinuation { (continuation: CheckedContinuation<Bool, Never>) in
                waiters.append((id: id, continuation: continuation))
            }
        } onCancel: {
            Task { await self.cancelWaiter(id: id) }
        }
        return acquired
    }

    /// Removes a cancelled waiter from the queue (no slot consumed → resumes
    /// with `false`). If signal() already resumed this waiter (slot consumed →
    /// resumed with `true`), does nothing.
    private func cancelWaiter(id: UInt64) {
        if let idx = waiters.firstIndex(where: { $0.id == id }) {
            let removed = waiters.remove(at: idx)
            removed.continuation.resume(returning: false)
        }
    }

    func signal() {
        if let waiter = waiters.first {
            waiters.removeFirst()
            waiter.continuation.resume(returning: true)
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

        let acquired = await semaphore.wait()
        guard acquired else { return .unknown }
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
