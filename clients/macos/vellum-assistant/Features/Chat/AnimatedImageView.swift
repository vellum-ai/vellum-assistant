import SwiftUI
import AppKit
import VellumAssistantShared

/// Displays a remote image with animated GIF support.
///
/// Uses a two-layer approach:
/// - SwiftUI `AsyncImage`-style state machine for layout and static images
/// - `NSViewRepresentable` wrapping `NSImageView` with `animates = true` for GIFs
///
/// The Coordinator tracks the current URL to prevent redundant downloads across
/// streaming re-renders.
struct AnimatedImageView: View {
    let urlString: String

    @State private var loadedImage: NSImage?
    @State private var imageData: Data?
    @State private var isLoading = true
    @State private var isGIF: Bool = false
    @Environment(\.displayScale) private var displayScale

    // MARK: - In-memory cache

    /// Wrapper that stores both the decoded image and optional GIF data together,
    /// ensuring they are evicted atomically. This prevents the edge case where
    /// the image survives eviction but the GIF data doesn't, which would cause
    /// animated GIFs to silently degrade to static images.
    private class CachedImageEntry: NSObject {
        let image: NSImage
        let gifData: Data?
        init(image: NSImage, gifData: Data?) {
            self.image = image
            self.gifData = gifData
        }
    }

    /// Single cache for decoded images + optional GIF data.
    /// Keyed by resolved absolute path or full URL string to avoid cross-assistant
    /// collisions on relative workspace paths.
    private static let cache: NSCache<NSString, CachedImageEntry> = {
        let cache = NSCache<NSString, CachedImageEntry>()
        cache.countLimit = 50
        // ~50 MB — estimated cost is set per-entry based on pixel dimensions + GIF data size.
        cache.totalCostLimit = 50 * 1024 * 1024
        return cache
    }()

    /// Maximum display dimension in points (matches text bubble maxWidth).
    private let maxDimension: CGFloat = VSpacing.chatBubbleMaxWidth

    var body: some View {
        Group {
            if let data = imageData, isGIF {
                GIFView(data: data)
                    .frame(
                        width: min(gifSize.width, maxDimension),
                        height: min(gifSize.height, maxDimension)
                    )
            } else if let image = loadedImage,
                      let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) {
                // Use CGImage with the display's scale factor so each source pixel
                // maps to exactly one backing-store pixel on Retina displays,
                // preventing the upscale blur that Image(nsImage:) causes.
                let nativeWidth = CGFloat(cgImage.width) / displayScale
                let nativeHeight = CGFloat(cgImage.height) / displayScale
                Image(decorative: cgImage, scale: displayScale)
                    .resizable()
                    .interpolation(.high)
                    .aspectRatio(contentMode: .fit)
                    .frame(
                        maxWidth: min(nativeWidth, maxDimension),
                        maxHeight: min(nativeHeight, maxDimension)
                    )
            } else if let image = loadedImage {
                // Fallback when CGImage extraction fails
                Image(nsImage: image)
                    .resizable()
                    .aspectRatio(contentMode: .fit)
                    .frame(maxWidth: maxDimension, maxHeight: maxDimension)
            } else {
                VIconView(.image, size: 24)
                    .foregroundStyle(VColor.contentTertiary)
                    .frame(width: 80, height: 60)
            }
        }
        .task(id: urlString) {
            await loadImage()
        }
    }

    private var gifSize: CGSize {
        guard let image = loadedImage else { return CGSize(width: maxDimension, height: maxDimension) }
        let size = image.size
        guard size.width > 0, size.height > 0 else { return CGSize(width: maxDimension, height: maxDimension) }
        let scale = min(maxDimension / size.width, maxDimension / size.height, 1.0)
        return CGSize(width: size.width * scale, height: size.height * scale)
    }

    /// Resolves the cache key and source type for the given URL string.
    ///
    /// Returns a tuple of:
    /// - `key`: cache key string (includes assistant ID for workspace paths to avoid cross-assistant collisions)
    /// - `fileURL`: non-nil for absolute local paths (read from disk)
    /// - `workspacePath`: non-nil for workspace-relative paths (fetched via gateway API)
    ///
    /// When both `fileURL` and `workspacePath` are nil the URL is treated as a remote HTTP(S) resource.
    private func resolveCacheKey() -> (key: NSString, fileURL: URL?, workspacePath: String?) {
        // Absolute local paths — already unique.
        if urlString.hasPrefix("/") || urlString.hasPrefix("file://") {
            let fileURL = urlString.hasPrefix("file://")
                ? URL(string: urlString)
                : URL(fileURLWithPath: urlString)
            return (urlString as NSString, fileURL, nil)
        }

        // Relative workspace paths — fetch via gateway, keyed by assistant ID to avoid collisions.
        if !urlString.contains("://") {
            let assistantId = LockfileAssistant.loadActiveAssistantId() ?? "default"
            let cacheKey = "workspace://\(assistantId)/\(urlString)"
            return (cacheKey as NSString, nil, urlString)
        }

        // Remote URLs — use as-is.
        return (urlString as NSString, nil, nil)
    }

    private func loadImage() async {
        isLoading = true
        defer { isLoading = false }

        let (cacheKey, localFileURL, workspacePath) = resolveCacheKey()

        // Absolute local file paths — read from disk off main thread.
        if let fileURL = localFileURL {
            // Phase 1: resolve mtime-aware cache key off main thread.
            let cacheKeyString = cacheKey as String
            let effectiveKey = await Task.detached(priority: .userInitiated) { () -> String in
                if let attrs = try? FileManager.default.attributesOfItem(atPath: cacheKeyString),
                   let mtime = attrs[.modificationDate] as? Date {
                    return "\(cacheKeyString)?\(mtime.timeIntervalSince1970)"
                }
                return cacheKeyString
            }.value as NSString
            guard !Task.isCancelled else { return }

            // Check in-memory cache before reading file bytes.
            if let entry = Self.cache.object(forKey: effectiveKey) {
                self.loadedImage = entry.image
                self.imageData = entry.gifData
                self.isGIF = entry.gifData != nil
                return
            }

            // Phase 2: cache miss — read file data off main thread.
            let fileData = await Task.detached(priority: .userInitiated) {
                try? Data(contentsOf: fileURL)
            }.value
            guard !Task.isCancelled else { return }

            imageData = fileData
            loadedImage = fileData.flatMap { NSImage(data: $0) }
            if let data = fileData { isGIF = isAnimatedGIF(data) }
            cacheLoadedImage(forKey: effectiveKey)
            return
        }

        // Workspace-relative paths — fetch via gateway API.
        if let workspacePath {
            let effectiveKey = cacheKey
            if let entry = Self.cache.object(forKey: effectiveKey) {
                self.loadedImage = entry.image
                self.imageData = entry.gifData
                self.isGIF = entry.gifData != nil
                return
            }

            do {
                let data = try await WorkspaceClient().fetchWorkspaceFileContent(
                    path: workspacePath, showHidden: false
                )
                guard !Task.isCancelled else { return }
                self.imageData = data
                self.loadedImage = NSImage(data: data)
                self.isGIF = isAnimatedGIF(data)
                cacheLoadedImage(forKey: effectiveKey)
            } catch {
                // Clear any stale image state so the placeholder shows instead of
                // an unrelated image that was previously rendered by this view.
                self.loadedImage = nil
                self.imageData = nil
                self.isGIF = false
            }
            return
        }

        // Remote URLs — use URL string as cache key (no mtime).
        let effectiveKey = cacheKey

        // Check in-memory cache first to avoid redundant downloads.
        if let entry = Self.cache.object(forKey: effectiveKey) {
            self.loadedImage = entry.image
            self.imageData = entry.gifData
            self.isGIF = entry.gifData != nil
            return
        }

        guard let url = URL(string: urlString) else { return }

        do {
            let data = try await ImageCache.shared.imageData(for: url)
            self.imageData = data
            self.loadedImage = NSImage(data: data)
            self.isGIF = isAnimatedGIF(data)
            cacheLoadedImage(forKey: effectiveKey)
        } catch {
            // Keep placeholder on failure
        }
    }

    /// Stores the currently loaded image (and GIF data if applicable) into the
    /// static in-memory cache. Cost is estimated from pixel dimensions so the
    /// `totalCostLimit` on NSCache approximates real memory pressure.
    private func cacheLoadedImage(forKey key: NSString) {
        guard let image = loadedImage else { return }

        // Estimate memory cost: width * height * 4 bytes (RGBA) + GIF data size
        let rep = image.representations.first
        let pixelWidth = rep?.pixelsWide ?? Int(image.size.width)
        let pixelHeight = rep?.pixelsHigh ?? Int(image.size.height)
        let imageCost = pixelWidth * pixelHeight * 4
        let gifDataCost = imageData.map { isGIF ? $0.count : 0 } ?? 0
        let gifData = imageData.flatMap { isGIF ? $0 : nil }

        let entry = CachedImageEntry(image: image, gifData: gifData)
        Self.cache.setObject(entry, forKey: key, cost: imageCost + gifDataCost)
    }

    private func isAnimatedGIF(_ data: Data) -> Bool {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return false }
        return CGImageSourceGetCount(source) > 1
    }
}

/// NSViewRepresentable that renders animated GIF data via NSImageView.
private struct GIFView: NSViewRepresentable {
    let data: Data

    func makeNSView(context: Context) -> NSImageView {
        let imageView = NSImageView()
        imageView.imageScaling = .scaleProportionallyUpOrDown
        imageView.animates = true
        imageView.isEditable = false
        imageView.canDrawSubviewsIntoLayer = true
        if let image = NSImage(data: data) {
            imageView.image = image
        }
        return imageView
    }

    func updateNSView(_ nsView: NSImageView, context: Context) {
        // Data is immutable per GIF URL — no updates needed
    }

    static func dismantleNSView(_ nsView: NSImageView, coordinator: ()) {
        nsView.animates = false
        nsView.image = nil
    }
}
