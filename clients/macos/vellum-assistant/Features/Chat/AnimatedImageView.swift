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

    // MARK: - Cached workspace directory

    /// Cached workspace directory to avoid synchronous lockfile reads per image.
    /// Set once on first resolve, cleared on assistant disconnect if needed.
    @MainActor private static var cachedWorkspaceDir: String?
    @MainActor private static var workspaceDirResolved = false

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
                    .foregroundColor(VColor.contentTertiary)
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

    /// Resolves the cache key for the given URL string. For workspace-relative paths,
    /// this includes the resolved absolute path so different assistants don't collide.
    private func resolveCacheKey() -> (key: NSString, fileURL: URL?)  {
        // Absolute local paths — already unique.
        if urlString.hasPrefix("/") || urlString.hasPrefix("file://") {
            let fileURL = urlString.hasPrefix("file://")
                ? URL(string: urlString)
                : URL(fileURLWithPath: urlString)
            return (urlString as NSString, fileURL)
        }

        // Relative workspace paths — resolve to absolute to avoid cross-assistant collisions.
        if !urlString.contains("://") {
            if !Self.workspaceDirResolved {
                if let assistantId = UserDefaults.standard.string(forKey: "connectedAssistantId"),
                   let assistant = LockfileAssistant.loadByName(assistantId),
                   let resolved = assistant.workspaceDir {
                    Self.cachedWorkspaceDir = resolved
                }
                Self.workspaceDirResolved = true
            }
            let workspaceDir = Self.cachedWorkspaceDir ?? (NSHomeDirectory() + "/.vellum/workspace")
            let absolutePath = workspaceDir + "/" + urlString
            let fileURL = URL(fileURLWithPath: absolutePath)
            return (absolutePath as NSString, fileURL)
        }

        // Remote URLs — use as-is.
        return (urlString as NSString, nil)
    }

    private func loadImage() async {
        isLoading = true
        defer { isLoading = false }

        let (cacheKey, localFileURL) = resolveCacheKey()

        // Local file paths (absolute or workspace-relative, already resolved).
        // Move file I/O (mtime check + data read) off main thread via detached task.
        if let fileURL = localFileURL {
            let (effectiveKey, fileData) = await Task.detached(priority: .userInitiated) { () -> (NSString, Data?) in
                // Incorporate mtime so overwritten files bust the cache.
                let effectiveKey: NSString
                if let attrs = try? FileManager.default.attributesOfItem(atPath: cacheKey as String),
                   let mtime = attrs[.modificationDate] as? Date {
                    effectiveKey = "\(cacheKey)?\(mtime.timeIntervalSince1970)" as NSString
                } else {
                    effectiveKey = cacheKey
                }
                let data = try? Data(contentsOf: fileURL)
                return (effectiveKey, data)
            }.value
            guard !Task.isCancelled else { return }

            // Check in-memory cache (on main — NSCache lookup is fast).
            if let entry = Self.cache.object(forKey: effectiveKey) {
                self.loadedImage = entry.image
                self.imageData = entry.gifData
                self.isGIF = entry.gifData != nil
                return
            }

            imageData = fileData
            loadedImage = fileData.flatMap { NSImage(data: $0) }
            if let data = fileData { isGIF = isAnimatedGIF(data) }
            cacheLoadedImage(forKey: effectiveKey)
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
