import Foundation

/// Probes URLs via HTTP HEAD to determine whether they serve image content.
///
/// This is the second stage of image detection, used for extensionless URLs
/// that `ImageURLClassifier` returns `.unknown` for. Results are cached
/// in-memory to avoid redundant network requests.
final class ImageMIMEProbe {
    static let shared = ImageMIMEProbe()

    private let cache = NSCache<NSString, CacheEntry>()
    private let session: URLSession

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
    func probe(_ url: URL) async -> ImageURLClassification {
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

    func clearCache() {
        cache.removeAllObjects()
    }
}
