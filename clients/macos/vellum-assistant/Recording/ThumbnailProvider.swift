import AppKit
import ScreenCaptureKit
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "ThumbnailProvider")

/// Result of a thumbnail capture attempt.
struct ThumbnailResult {
    let image: NSImage?
    let status: PreviewStatus
    /// Whether the result was served from the in-memory cache (no fresh capture).
    let fromCache: Bool
}

/// Captures, normalizes, and caches source preview thumbnails.
///
/// Uses `SCScreenshotManager` to capture display and window
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
        // Slot was transferred by releaseSlot — no increment needed
    }

    /// Release a capture slot, resuming the next waiter if any.
    private func releaseSlot() {
        if !waitingContinuations.isEmpty {
            let next = waitingContinuations.removeFirst()
            // Transfer the slot directly — don't decrement
            next.resume()
        } else {
            activeCaptureCount -= 1
        }
    }

    // MARK: - Display Capture

    /// Capture a thumbnail for a display source.
    func captureThumbnail(for display: DisplaySource) async -> ThumbnailResult {
        let cacheKey = "display-\(display.id)"

        if let cached = cachedThumbnail(for: cacheKey) {
            return ThumbnailResult(image: cached, status: .loaded, fromCache: true)
        }

        guard let scDisplay = display.scDisplay else {
            log.warning("No SCDisplay reference for display \(display.id)")
            return ThumbnailResult(image: nil, status: .failed(.sourceGone), fromCache: false)
        }

        await acquireSlot()
        guard !Task.isCancelled else {
            releaseSlot()
            return ThumbnailResult(image: nil, status: .failed(.cancelled), fromCache: false)
        }
        let result: ThumbnailResult
        do {
            let selfBundleId = Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant"
            let selfPid = ProcessInfo.processInfo.processIdentifier

            // Get current shareable content to find Vellum app windows to exclude.
            // Match by bundle ID first, falling back to PID for SPM builds where
            // Bundle.main.bundleIdentifier is nil and the fallback string may not match.
            let shareable = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
            let vellumApps = shareable.applications.filter {
                $0.bundleIdentifier == selfBundleId || $0.processID == selfPid
            }

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
                result = ThumbnailResult(image: nil, status: .failed(.blankFrame), fromCache: false)
            } else {
                let nsImage = NSImage(cgImage: cgImage, size: NSSize(width: cgImage.width, height: cgImage.height))
                if let normalized = normalizeToThumbnail(nsImage) {
                    cache(normalized, for: cacheKey)
                    result = ThumbnailResult(image: normalized, status: .loaded, fromCache: false)
                } else {
                    result = ThumbnailResult(image: nil, status: .failed(.captureFailed), fromCache: false)
                }
            }
        } catch {
            log.error("Failed to capture display \(display.id) thumbnail: \(error.localizedDescription)")
            result = ThumbnailResult(image: nil, status: .failed(.captureFailed), fromCache: false)
        }
        releaseSlot()
        return result
    }

    // MARK: - Window Capture

    /// Capture a thumbnail for a window source.
    func captureThumbnail(for window: WindowSource) async -> ThumbnailResult {
        let cacheKey = "window-\(window.id)"

        if let cached = cachedThumbnail(for: cacheKey) {
            return ThumbnailResult(image: cached, status: .loaded, fromCache: true)
        }

        guard let scWindow = window.scWindow else {
            log.warning("No SCWindow reference for window \(window.id)")
            return ThumbnailResult(image: nil, status: .failed(.sourceGone), fromCache: false)
        }

        await acquireSlot()
        guard !Task.isCancelled else {
            releaseSlot()
            return ThumbnailResult(image: nil, status: .failed(.cancelled), fromCache: false)
        }
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
                result = ThumbnailResult(image: nil, status: .failed(.blankFrame), fromCache: false)
            } else {
                let nsImage = NSImage(cgImage: cgImage, size: NSSize(width: cgImage.width, height: cgImage.height))
                if let normalized = normalizeToThumbnail(nsImage) {
                    cache(normalized, for: cacheKey)
                    result = ThumbnailResult(image: normalized, status: .loaded, fromCache: false)
                } else {
                    result = ThumbnailResult(image: nil, status: .failed(.captureFailed), fromCache: false)
                }
            }
        } catch {
            log.error("Failed to capture window \(window.id) thumbnail: \(error.localizedDescription)")
            result = ThumbnailResult(image: nil, status: .failed(.captureFailed), fromCache: false)
        }
        releaseSlot()
        return result
    }

    // MARK: - Image Processing

    /// Scale image to fit within max thumbnail dimensions, preserving aspect ratio.
    /// Uses NSBitmapImageRep + NSGraphicsContext instead of lockFocus/unlockFocus
    /// so it is safe to call off the main thread.
    private func normalizeToThumbnail(_ image: NSImage) -> NSImage? {
        let originalSize = image.size
        guard originalSize.width > 0, originalSize.height > 0 else { return nil }

        let scale = min(
            Self.maxThumbnailWidth / originalSize.width,
            Self.maxThumbnailHeight / originalSize.height,
            1.0
        )
        let targetSize = NSSize(
            width: round(originalSize.width * scale),
            height: round(originalSize.height * scale)
        )

        guard let bitmapRep = NSBitmapImageRep(
            bitmapDataPlanes: nil,
            pixelsWide: Int(targetSize.width),
            pixelsHigh: Int(targetSize.height),
            bitsPerSample: 8,
            samplesPerPixel: 4,
            hasAlpha: true,
            isPlanar: false,
            colorSpaceName: .deviceRGB,
            bytesPerRow: 0,
            bitsPerPixel: 0
        ) else { return nil }

        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmapRep)
        image.draw(
            in: NSRect(origin: .zero, size: targetSize),
            from: NSRect(origin: .zero, size: originalSize),
            operation: .copy,
            fraction: 1.0
        )
        NSGraphicsContext.restoreGraphicsState()

        let thumbnail = NSImage(size: targetSize)
        thumbnail.addRepresentation(bitmapRep)
        return thumbnail
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
