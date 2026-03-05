import AppKit
import Foundation

/// Thread-safe, identity-keyed cache for decoded app preview images.
/// Decodes the base64 preview payload once per unique (appId, base64) pair
/// and returns the cached `NSImage` on subsequent calls, avoiding redundant
/// `Data(base64Encoded:)` + `NSImage(data:)` work on every SwiftUI body pass.
@MainActor
enum AppPreviewImageStore {

    // MARK: - Storage

    /// Underlying NSCache — automatically evicts under memory pressure.
    private static let cache = NSCache<NSString, NSImage>()
    /// Tracks the base64 token that produced each cached image so a changed
    /// preview payload invalidates the stale entry.
    private static var tokenMap: [String: Int] = [:]

    // MARK: - API

    /// Returns a decoded `NSImage` for the given preview, using the cache when
    /// the base64 payload hasn't changed since the last call for this `appId`.
    static func image(appId: String, base64: String?) -> NSImage? {
        guard let base64, !base64.isEmpty else { return nil }

        let token = base64.hashValue
        let key = appId as NSString

        // Fast path: cached and token matches
        if let cached = cache.object(forKey: key), tokenMap[appId] == token {
            return cached
        }

        // Decode and cache
        guard let data = Data(base64Encoded: base64),
              let nsImage = NSImage(data: data) else {
            return nil
        }

        cache.setObject(nsImage, forKey: key)
        tokenMap[appId] = token
        return nsImage
    }

    /// Removes the cached image for `appId` (e.g. on app deletion).
    static func remove(appId: String) {
        cache.removeObject(forKey: appId as NSString)
        tokenMap.removeValue(forKey: appId)
    }
}
