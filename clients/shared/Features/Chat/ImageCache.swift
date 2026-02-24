import Foundation
#if os(macOS)
import AppKit
#elseif os(iOS)
import UIKit
#endif

/// Thread-safe, NSCache-backed image cache that coalesces duplicate in-flight requests.
/// Used by ``AnimatedImageView`` to avoid redundant downloads during streaming re-renders.
public actor ImageCache {
    public static let shared = ImageCache()

    private let dataCache = NSCache<NSURL, NSData>()
    private var inFlight: [URL: Task<Data, Error>] = [:]

    private init() {
        dataCache.countLimit = 250
    }

    /// Returns raw `Data` for the URL (needed for GIF animation frames).
    public func imageData(for url: URL) async throws -> Data {
        let nsURL = url as NSURL

        // Return from cache if available
        if let cachedData = dataCache.object(forKey: nsURL) {
            return cachedData as Data
        }

        // Coalesce duplicate in-flight requests
        if let existing = inFlight[url] {
            return try await existing.value
        }

        let task = Task<Data, Error> {
            // URLSession.shared is intentional here: inline chat images may come from any
            // user-provided domain, so domain pinning would break legitimate use.
            // ATS (App Transport Security) enforces HTTPS on iOS/macOS in production
            // builds, providing baseline transport security without explicit cert pinning.
            let (data, response) = try await URLSession.shared.data(from: url)
            if let http = response as? HTTPURLResponse, !(200...299).contains(http.statusCode) {
                throw URLError(.badServerResponse)
            }
            return data
        }

        inFlight[url] = task

        do {
            let data = try await task.value
            dataCache.setObject(data as NSData, forKey: nsURL)
            inFlight[url] = nil
            return data
        } catch {
            inFlight[url] = nil
            throw error
        }
    }
}
