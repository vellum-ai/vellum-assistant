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
public struct VAvatarImage: View {
    public let image: NSImage
    public let size: CGFloat

    /// Optional border color. Defaults to `VColor.borderBase`.
    public var borderColor: Color = VColor.borderBase

    /// Whether to show a subtle border around the avatar.
    public var showBorder: Bool = true

    /// Whether the source image has a transparent background, computed once at init.
    private let isTransparent: Bool

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
        self.isTransparent = Self.imageHasTransparency(image)
    }

    public var body: some View {
        if isTransparent {
            baseImage
                .aspectRatio(contentMode: .fit)
                .frame(width: size, height: size)
                .accessibilityHidden(true)
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
                .accessibilityHidden(true)
        }
    }

    private var baseImage: some View {
        Image(nsImage: image)
            .interpolation(.none)
            .resizable()
    }

    /// Detect whether an NSImage contains transparent pixels by sampling its bitmap.
    ///
    /// Results are cached on the `NSImage` instance via `objc_setAssociatedObject`,
    /// so repeated calls with the same image (e.g. during SwiftUI body re-evaluation)
    /// return immediately without allocating a CGContext.
    ///
    /// For images larger than ``maxSamplingDimension``, the CGContext is created at
    /// a downsampled resolution — only 8 sample points are needed, so full-resolution
    /// rendering is unnecessary.
    static func imageHasTransparency(_ nsImage: NSImage) -> Bool {
        // Return cached result if available.
        if let cached = objc_getAssociatedObject(nsImage, &transparencyCacheKey) as? Bool {
            return cached
        }

        let result = computeTransparency(nsImage)
        objc_setAssociatedObject(nsImage, &transparencyCacheKey, result, .OBJC_ASSOCIATION_RETAIN_NONATOMIC)
        return result
    }

    /// Core transparency detection logic, separated from caching for testability.
    private static func computeTransparency(_ nsImage: NSImage) -> Bool {
        guard let cgImage = nsImage.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
            return false
        }

        // If the pixel format has no alpha channel, the image is fully opaque.
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
