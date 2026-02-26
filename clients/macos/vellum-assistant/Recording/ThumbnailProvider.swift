import AppKit
import ScreenCaptureKit
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "ThumbnailProvider")

/// Result of a thumbnail capture attempt.
struct ThumbnailResult {
    let image: NSImage?
    let status: PreviewStatus
}

/// Captures, normalizes, and caches source preview thumbnails.
///
/// Uses `SCScreenshotManager` (macOS 14+) to capture display and window
/// screenshots, scales them to a max of 320x200pt for picker row thumbnails,
/// and maintains an in-memory cache with a 30-second TTL.
///
/// Concurrency is limited to 3 simultaneous captures via a semaphore.
actor ThumbnailProvider {

    // MARK: - Configuration

    /// Maximum capture resolution (before normalization).
    private static let maxCaptureWidth = 640
    /// Maximum thumbnail dimensions for row display.
    private static let maxThumbnailWidth: CGFloat = 320
    private static let maxThumbnailHeight: CGFloat = 200
    /// Cache entry TTL in seconds.
    private static let cacheTTLSeconds: TimeInterval = 30
    /// Maximum number of concurrent captures.
    private static let maxConcurrentCaptures = 3

    // MARK: - Cache

    private struct CacheEntry {
        let image: NSImage
        let timestamp: Date
    }

    private var cache: [String: CacheEntry] = [:]

    /// Returns a cached thumbnail if it exists and is within the TTL window.
    func cachedThumbnail(for key: String) -> NSImage? {
        guard let entry = cache[key] else { return nil }
        if Date().timeIntervalSince(entry.timestamp) > Self.cacheTTLSeconds {
            cache.removeValue(forKey: key)
            return nil
        }
        return entry.image
    }

    /// Stores a thumbnail in the cache with the current timestamp.
    func cache(_ image: NSImage, for key: String) {
        cache[key] = CacheEntry(image: image, timestamp: Date())
    }

    /// Removes all cached thumbnails. Called when the picker is dismissed.
    func clearCache() {
        cache.removeAll()
    }

    // MARK: - Concurrency Limiting

    private var activeCaptureCount = 0
    private var waitingContinuations: [CheckedContinuation<Void, Never>] = []

    /// Acquire a capture slot, waiting if the maximum is already in use.
    private func acquireSlot() async {
        if activeCaptureCount < Self.maxConcurrentCaptures {
            activeCaptureCount += 1
            return
        }
        await withCheckedContinuation { continuation in
            waitingContinuations.append(continuation)
        }
        activeCaptureCount += 1
    }

    /// Release a capture slot, resuming the next waiter if any.
    private func releaseSlot() {
        activeCaptureCount -= 1
        if !waitingContinuations.isEmpty {
            let next = waitingContinuations.removeFirst()
            next.resume()
        }
    }

    // MARK: - Display Capture

    /// Capture a thumbnail for a display source.
    func captureThumbnail(for display: DisplaySource) async -> ThumbnailResult {
        let cacheKey = "display-\(display.id)"

        if let cached = cachedThumbnail(for: cacheKey) {
            return ThumbnailResult(image: cached, status: .loaded)
        }

        guard let scDisplay = display.scDisplay else {
            log.warning("No SCDisplay reference for display \(display.id)")
            return ThumbnailResult(image: nil, status: .failed(.sourceGone))
        }

        guard #available(macOS 14, *) else {
            return ThumbnailResult(image: nil, status: .failed(.captureFailed))
        }

        await acquireSlot()
        let result: ThumbnailResult
        do {
            let selfBundleId = Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant"

            // Get current shareable content to find Vellum app windows to exclude
            let shareable = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
            let vellumApps = shareable.applications.filter { $0.bundleIdentifier == selfBundleId }

            let filter = SCContentFilter(
                display: scDisplay,
                excludingApplications: vellumApps,
                exceptingWindows: []
            )

            let config = SCStreamConfiguration()
            // Cap capture resolution for performance
            let aspectRatio = CGFloat(display.height) / CGFloat(display.width)
            config.width = Self.maxCaptureWidth
            config.height = Int(CGFloat(Self.maxCaptureWidth) * aspectRatio)
            config.pixelFormat = kCVPixelFormatType_32BGRA
            config.showsCursor = false

            let cgImage = try await SCScreenshotManager.captureImage(
                contentFilter: filter,
                configuration: config
            )

            // Check for blank frame (all pixels the same or empty)
            if isBlankImage(cgImage) {
                log.debug("Blank frame captured for display \(display.id)")
                result = ThumbnailResult(image: nil, status: .failed(.blankFrame))
            } else {
                let nsImage = NSImage(cgImage: cgImage, size: NSSize(width: cgImage.width, height: cgImage.height))
                let normalized = normalizeToThumbnail(nsImage)
                cache(normalized, for: cacheKey)
                result = ThumbnailResult(image: normalized, status: .loaded)
            }
        } catch {
            log.error("Failed to capture display \(display.id) thumbnail: \(error.localizedDescription)")
            result = ThumbnailResult(image: nil, status: .failed(.captureFailed))
        }
        releaseSlot()
        return result
    }

    // MARK: - Window Capture

    /// Capture a thumbnail for a window source.
    func captureThumbnail(for window: WindowSource) async -> ThumbnailResult {
        let cacheKey = "window-\(window.id)"

        if let cached = cachedThumbnail(for: cacheKey) {
            return ThumbnailResult(image: cached, status: .loaded)
        }

        guard let scWindow = window.scWindow else {
            log.warning("No SCWindow reference for window \(window.id)")
            return ThumbnailResult(image: nil, status: .failed(.sourceGone))
        }

        guard #available(macOS 14, *) else {
            return ThumbnailResult(image: nil, status: .failed(.captureFailed))
        }

        await acquireSlot()
        let result: ThumbnailResult
        do {
            let filter = SCContentFilter(desktopIndependentWindow: scWindow)

            let config = SCStreamConfiguration()
            // Use the window's actual aspect ratio for proportional sizing
            let windowWidth = max(scWindow.frame.width, 1)
            let windowHeight = max(scWindow.frame.height, 1)
            let aspectRatio = windowHeight / windowWidth
            config.width = Self.maxCaptureWidth
            config.height = Int(CGFloat(Self.maxCaptureWidth) * aspectRatio)
            config.pixelFormat = kCVPixelFormatType_32BGRA
            config.showsCursor = false

            let cgImage = try await SCScreenshotManager.captureImage(
                contentFilter: filter,
                configuration: config
            )

            if isBlankImage(cgImage) {
                log.debug("Blank frame captured for window \(window.id)")
                result = ThumbnailResult(image: nil, status: .failed(.blankFrame))
            } else {
                let nsImage = NSImage(cgImage: cgImage, size: NSSize(width: cgImage.width, height: cgImage.height))
                let normalized = normalizeToThumbnail(nsImage)
                cache(normalized, for: cacheKey)
                result = ThumbnailResult(image: normalized, status: .loaded)
            }
        } catch {
            log.error("Failed to capture window \(window.id) thumbnail: \(error.localizedDescription)")
            result = ThumbnailResult(image: nil, status: .failed(.captureFailed))
        }
        releaseSlot()
        return result
    }

    // MARK: - Image Processing

    /// Scale image to fit within max thumbnail dimensions, preserving aspect ratio.
    private func normalizeToThumbnail(_ image: NSImage) -> NSImage {
        let originalSize = image.size
        guard originalSize.width > 0, originalSize.height > 0 else { return image }

        let widthScale = Self.maxThumbnailWidth / originalSize.width
        let heightScale = Self.maxThumbnailHeight / originalSize.height
        let scale = min(widthScale, heightScale, 1.0) // Don't upscale

        if scale >= 1.0 { return image }

        let newSize = NSSize(
            width: round(originalSize.width * scale),
            height: round(originalSize.height * scale)
        )

        let resized = NSImage(size: newSize)
        resized.lockFocus()
        NSGraphicsContext.current?.imageInterpolation = .high
        image.draw(
            in: NSRect(origin: .zero, size: newSize),
            from: NSRect(origin: .zero, size: originalSize),
            operation: .copy,
            fraction: 1.0
        )
        resized.unlockFocus()
        return resized
    }

    /// Heuristic check for blank/empty captures by sampling corner pixels.
    /// Returns true if all sampled pixels are identical (likely a blank frame).
    private func isBlankImage(_ image: CGImage) -> Bool {
        guard image.width > 0, image.height > 0 else { return true }

        // Quick check: sample a few pixels from different regions
        guard let dataProvider = image.dataProvider,
              let data = dataProvider.data,
              let bytes = CFDataGetBytePtr(data) else {
            return true
        }

        let bytesPerPixel = image.bitsPerPixel / 8
        let bytesPerRow = image.bytesPerRow
        guard bytesPerPixel >= 3, bytesPerRow > 0 else { return true }

        // Sample points: top-left, center, bottom-right, top-right
        let points: [(Int, Int)] = [
            (0, 0),
            (image.width / 2, image.height / 2),
            (max(image.width - 1, 0), max(image.height - 1, 0)),
            (max(image.width - 1, 0), 0)
        ]

        var firstR: UInt8 = 0, firstG: UInt8 = 0, firstB: UInt8 = 0
        var isFirst = true

        for (x, y) in points {
            guard x < image.width, y < image.height else { continue }
            let offset = y * bytesPerRow + x * bytesPerPixel
            let totalBytes = CFDataGetLength(data)
            guard offset + 2 < totalBytes else { continue }

            let r = bytes[offset]
            let g = bytes[offset + 1]
            let b = bytes[offset + 2]

            if isFirst {
                firstR = r; firstG = g; firstB = b
                isFirst = false
                continue
            }

            if r != firstR || g != firstG || b != firstB {
                return false
            }
        }

        return true
    }
}
