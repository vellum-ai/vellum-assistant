#if os(macOS)
import ObjectiveC
import SwiftUI

// MARK: - Associated-object key for transparency cache

/// Key used by `objc_setAssociatedObject` to attach a cached transparency
/// result directly to an `NSImage` instance. This avoids repeated CGContext
/// allocations when the same image is passed to multiple `VAvatarImage` inits
/// (e.g. during SwiftUI body re-evaluation).
private var transparencyCacheKey: UInt8 = 0

/// Reusable avatar image that adapts its clip shape based on image transparency.
/// Images with transparent backgrounds render unclipped so the full artwork
/// (ears, antennae, etc.) is visible. Opaque images render in a circle.
///
/// Transparency detection is CPU-bound (CGContext allocation + `CGContext.draw`
/// + pixel sampling) and is **never run synchronously** during SwiftUI view
/// initialization. Doing so has blocked the main thread in production — see
/// LUM-915. Instead, `isTransparent` is a `@State` value seeded from the
/// associated-object cache and refreshed via `.task(id:)` on a detached task.
public struct VAvatarImage: View {
    public let image: NSImage
    public let size: CGFloat

    /// Optional border color. Defaults to `VColor.borderBase`.
    public var borderColor: Color = VColor.borderBase

    /// Whether to show a subtle border around the avatar.
    public var showBorder: Bool = true

    /// Whether the source image has a transparent background.
    ///
    /// Seeded synchronously from the associated-object cache when available —
    /// this is an O(1) `objc_getAssociatedObject` lookup, not a pixel scan.
    /// On a cache miss, defaults to `false` (circle-clip) and is refreshed on
    /// the next frame by the async `.task` below. Defaulting to opaque keeps
    /// opaque images (the common case) rendered correctly from frame 1; the
    /// rare transparent cache-miss resolves within one frame of task dispatch.
    @State private var isTransparent: Bool

    /// Alpha byte value at or above which a pixel is considered opaque.
    /// Derived from `ceil(0.95 * 255) = 243`.
    static let alphaOpaqueThreshold: UInt8 = 243

    /// Maximum dimension for the sampling CGContext. Images larger than this
    /// are downsampled before pixel inspection — we only need 8 sample points,
    /// so full-resolution rendering is unnecessary.
    static let maxSamplingDimension = 64

    public init(image: NSImage, size: CGFloat, borderColor: Color = VColor.borderBase, showBorder: Bool = true) {
        self.image = image
        self.size = size
        self.borderColor = borderColor
        self.showBorder = showBorder
        let cached = objc_getAssociatedObject(image, &transparencyCacheKey) as? Bool
        self._isTransparent = State(initialValue: cached ?? false)
    }

    public var body: some View {
        Group {
            if isTransparent {
                baseImage
                    .aspectRatio(contentMode: .fit)
                    .frame(width: size, height: size)
            } else {
                baseImage
                    .aspectRatio(contentMode: .fill)
                    .frame(width: size, height: size)
                    .clipShape(Circle())
                    .overlay {
                        if showBorder {
                            Circle()
                                .strokeBorder(borderColor, lineWidth: 1)
                        }
                    }
            }
        }
        .accessibilityHidden(true)
        .task(id: ObjectIdentifier(image)) {
            await refreshTransparencyOffMain()
        }
    }

    private var baseImage: some View {
        Image(nsImage: image)
            .interpolation(.none)
            .resizable()
    }

    /// Refreshes `isTransparent` without blocking the main thread.
    ///
    /// - Hits the associated-object cache synchronously on the main actor
    ///   (O(1), no pixel work) and returns early on a hit.
    /// - On a cache miss, extracts the `CGImage` on the main actor — NSImage
    ///   is not thread-safe, per
    ///   [Apple docs](https://developer.apple.com/documentation/appkit/nsimage) —
    ///   then offloads the CGContext allocation, `CGContext.draw`, and alpha
    ///   sampling to a detached background task. `CGImage` is thread-safe and
    ///   crosses the actor boundary cleanly.
    ///
    /// This matches the pattern used by `OffscreenPreviewCapture.encodeOffMain`
    /// and the `@MainActor Isolation Boundaries` guidance in
    /// `clients/AGENTS.md`: keep state on the main actor, offload only the
    /// CPU-bound work.
    @MainActor
    private func refreshTransparencyOffMain() async {
        if let cached = objc_getAssociatedObject(image, &transparencyCacheKey) as? Bool {
            if isTransparent != cached {
                isTransparent = cached
            }
            return
        }

        guard let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
            if isTransparent != false {
                isTransparent = false
            }
            return
        }

        let computed = await Task.detached(priority: .userInitiated) {
            Self.computeTransparencyFromCGImage(cgImage)
        }.value

        guard !Task.isCancelled else { return }

        objc_setAssociatedObject(
            image,
            &transparencyCacheKey,
            computed,
            .OBJC_ASSOCIATION_RETAIN_NONATOMIC
        )
        if isTransparent != computed {
            isTransparent = computed
        }
    }

    /// Synchronous transparency check preserved for unit tests.
    ///
    /// **Do not call from view code.** The CGContext allocation + pixel draw
    /// is CPU-bound and has blocked the main thread in production (LUM-915).
    /// Production code must use the async `.task` path on `VAvatarImage`.
    /// Results are cached on the `NSImage` instance via
    /// `objc_setAssociatedObject` so tests that call this twice still observe
    /// caching behavior.
    static func imageHasTransparency(_ nsImage: NSImage) -> Bool {
        if let cached = objc_getAssociatedObject(nsImage, &transparencyCacheKey) as? Bool {
            return cached
        }

        guard let cgImage = nsImage.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
            return false
        }

        let result = computeTransparencyFromCGImage(cgImage)
        objc_setAssociatedObject(
            nsImage,
            &transparencyCacheKey,
            result,
            .OBJC_ASSOCIATION_RETAIN_NONATOMIC
        )
        return result
    }

    /// Core pixel-sampling logic. Takes a `CGImage` rather than an `NSImage`
    /// so it can run on any thread — `CGImage` is thread-safe, `NSImage` is
    /// not.
    ///
    /// - Returns `false` in O(1) when the pixel format has no alpha channel.
    /// - Otherwise draws into a downsampled 32-bit BGRA context and checks
    ///   the alpha byte at the 4 corners + 4 edge midpoints (8 points total).
    private static func computeTransparencyFromCGImage(_ cgImage: CGImage) -> Bool {
        let alphaInfo = cgImage.alphaInfo
        switch alphaInfo {
        case .none, .noneSkipFirst, .noneSkipLast:
            return false
        default:
            break
        }

        let sourceWidth = cgImage.width
        let sourceHeight = cgImage.height
        guard sourceWidth > 0, sourceHeight > 0 else { return false }

        // Downsample large images — we only need 8 sample points.
        let maxDim = maxSamplingDimension
        let width: Int
        let height: Int
        if sourceWidth > maxDim || sourceHeight > maxDim {
            let scale = Double(maxDim) / Double(max(sourceWidth, sourceHeight))
            width = max(1, Int(Double(sourceWidth) * scale))
            height = max(1, Int(Double(sourceHeight) * scale))
        } else {
            width = sourceWidth
            height = sourceHeight
        }

        // Draw into a known-layout 32-bit BGRA context so we can read alpha
        // bytes at predictable offsets regardless of the source pixel format.
        let bytesPerRow = width * 4
        let colorSpace = CGColorSpaceCreateDeviceRGB()
        let bitmapInfo = CGBitmapInfo.byteOrder32Little.rawValue | CGImageAlphaInfo.premultipliedFirst.rawValue
        guard let context = CGContext(
            data: nil,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: bytesPerRow,
            space: colorSpace,
            bitmapInfo: bitmapInfo
        ) else { return false }

        context.draw(cgImage, in: CGRect(x: 0, y: 0, width: width, height: height))
        guard let data = context.data else { return false }
        let pixels = data.bindMemory(to: UInt32.self, capacity: width * height)

        // Sample corners and edge midpoints (8 points).
        let samplePoints: [(Int, Int)] = [
            (0, 0), (width - 1, 0),
            (0, height - 1), (width - 1, height - 1),
            (width / 2, 0), (width / 2, height - 1),
            (0, height / 2), (width - 1, height / 2),
        ]

        // In BGRA-little-endian layout the alpha byte is bits 24-31.
        for (x, y) in samplePoints {
            let pixel = pixels[y * width + x]
            let alpha = UInt8((pixel >> 24) & 0xFF)
            if alpha < alphaOpaqueThreshold {
                return true
            }
        }

        return false
    }
}
#endif
