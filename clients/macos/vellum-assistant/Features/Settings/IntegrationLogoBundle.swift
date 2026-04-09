import AppKit
import SwiftUI
import VellumAssistantShared

/// Resolves bundled Simple Icons PDFs shipped inside the shared framework's
/// `Resources/IntegrationLogos/` directory. Returns `nil` for providers that
/// don't have a pre-bundled asset OR when the asset cannot be decoded —
/// callers should treat `nil` as "fall through to the next rendering tier"
/// (URL-based logo, then initials fallback).
///
/// Decoded `NSImage` instances are memoized in a process-wide store so that
/// repeated SwiftUI body evaluations do not re-read the PDF from disk. This
/// mirrors the `VIcon.nsImageStore` pattern in
/// `clients/shared/DesignSystem/Tokens/IconTokens.swift` and is required by
/// `clients/AGENTS.md`: "View bodies must be lightweight. Never perform I/O,
/// network calls, or heavy computation inside a SwiftUI view body."
enum IntegrationLogoBundle {
    /// Non-evicting store for loaded NSImage instances keyed by `provider_key`.
    /// A plain dictionary (rather than NSCache) preserves identity stability
    /// that SwiftUI relies on for diffing.
    private static var nsImageStore: [String: NSImage] = [:]
    private static let nsImageLock = NSLock()

    /// Also caches "miss" results so subsequent lookups for providers without
    /// bundled assets return immediately without hitting the file system.
    private static var missStore: Set<String> = []

    /// Loads and decodes the bundled asset for a provider. Returns `nil` when
    /// either the file doesn't exist in the bundle or `NSImage` fails to
    /// decode it (e.g. corrupt PDF). Checking presence + decode in a single
    /// call prevents a mismatch where existence says yes but the renderer
    /// silently returns EmptyView, breaking the fallback chain.
    ///
    /// Subsequent calls for the same provider return the cached `NSImage`
    /// (or cached miss) without touching disk.
    static func bundledImage(providerKey: String) -> NSImage? {
        nsImageLock.lock()
        if let cached = nsImageStore[providerKey] {
            nsImageLock.unlock()
            return cached
        }
        if missStore.contains(providerKey) {
            nsImageLock.unlock()
            return nil
        }
        nsImageLock.unlock()

        guard
            let url = Bundle.vellumShared.url(
                forResource: providerKey,
                withExtension: "pdf",
                subdirectory: "IntegrationLogos"
            ),
            let img = NSImage(contentsOf: url)
        else {
            nsImageLock.lock()
            missStore.insert(providerKey)
            nsImageLock.unlock()
            return nil
        }

        nsImageLock.lock()
        // Double-check in case another thread populated it while we were loading.
        if let existing = nsImageStore[providerKey] {
            nsImageLock.unlock()
            return existing
        }
        nsImageStore[providerKey] = img
        nsImageLock.unlock()
        return img
    }
}
