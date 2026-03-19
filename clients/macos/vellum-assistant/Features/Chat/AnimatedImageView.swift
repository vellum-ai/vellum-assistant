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
    @Environment(\.displayScale) private var displayScale

    // MARK: - In-memory caches

    /// Caches decoded NSImage instances to avoid redundant image decoding when
    /// LazyVStack recycles cells during scroll.
    private static let imageCache: NSCache<NSString, NSImage> = {
        let cache = NSCache<NSString, NSImage>()
        cache.countLimit = 50
        // ~50 MB — estimated cost is set per-image based on pixel dimensions.
        cache.totalCostLimit = 50 * 1024 * 1024
        return cache
    }()

    /// Caches raw GIF Data separately since animated GIFs need the original
    /// bytes (not just NSImage) to drive frame-by-frame animation.
    private static let gifDataCache: NSCache<NSString, NSData> = {
        let cache = NSCache<NSString, NSData>()
        cache.countLimit = 50
        cache.totalCostLimit = 50 * 1024 * 1024
        return cache
    }()

    /// Maximum display dimension in points (matches text bubble maxWidth).
    private let maxDimension: CGFloat = VSpacing.chatBubbleMaxWidth

    var body: some View {
        Group {
            if let data = imageData, isAnimatedGIF(data) {
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

    private func loadImage() async {
        isLoading = true
        defer { isLoading = false }

        let cacheKey = urlString as NSString

        // Check in-memory caches first to avoid redundant disk reads / decoding.
        if let cachedImage = Self.imageCache.object(forKey: cacheKey) {
            let cachedGIFData = Self.gifDataCache.object(forKey: cacheKey) as Data?
            self.loadedImage = cachedImage
            self.imageData = cachedGIFData
            return
        }

        // Support local file paths
        if urlString.hasPrefix("/") || urlString.hasPrefix("file://") {
            let fileURL = urlString.hasPrefix("file://")
                ? URL(string: urlString)
                : URL(fileURLWithPath: urlString)
            if let fileURL {
                imageData = try? Data(contentsOf: fileURL)
                loadedImage = imageData.flatMap { NSImage(data: $0) }
                cacheLoadedImage(forKey: cacheKey)
            }
            return
        }

        // Resolve relative workspace paths (e.g. "data/avatar/avatar-image.png")
        if !urlString.contains("://") {
            // Use the connected assistant's workspace dir for multi-instance support,
            // falling back to the default ~/.vellum/workspace path.
            let workspaceDir: String
            if let assistantId = UserDefaults.standard.string(forKey: "connectedAssistantId"),
               let assistant = LockfileAssistant.loadByName(assistantId),
               let resolved = assistant.workspaceDir {
                workspaceDir = resolved
            } else {
                workspaceDir = NSHomeDirectory() + "/.vellum/workspace"
            }
            let fileURL = URL(fileURLWithPath: workspaceDir + "/" + urlString)
            imageData = try? Data(contentsOf: fileURL)
            loadedImage = imageData.flatMap { NSImage(data: $0) }
            cacheLoadedImage(forKey: cacheKey)
            return
        }

        guard let url = URL(string: urlString) else { return }

        do {
            let data = try await ImageCache.shared.imageData(for: url)
            self.imageData = data
            self.loadedImage = NSImage(data: data)
            cacheLoadedImage(forKey: cacheKey)
        } catch {
            // Keep placeholder on failure
        }
    }

    /// Stores the currently loaded image (and GIF data if applicable) into the
    /// static in-memory caches. Cost is estimated from pixel dimensions so the
    /// `totalCostLimit` on NSCache approximates real memory pressure.
    private func cacheLoadedImage(forKey key: NSString) {
        guard let image = loadedImage else { return }

        // Estimate memory cost: width * height * 4 bytes (RGBA)
        let rep = image.representations.first
        let pixelWidth = rep?.pixelsWide ?? Int(image.size.width)
        let pixelHeight = rep?.pixelsHigh ?? Int(image.size.height)
        let cost = pixelWidth * pixelHeight * 4

        Self.imageCache.setObject(image, forKey: key, cost: cost)

        // Cache raw GIF data separately so animated GIFs still work on re-scroll.
        if let data = imageData, isAnimatedGIF(data) {
            Self.gifDataCache.setObject(data as NSData, forKey: key, cost: data.count)
        }
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
