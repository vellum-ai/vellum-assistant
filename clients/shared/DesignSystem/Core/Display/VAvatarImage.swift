#if os(macOS)
import SwiftUI

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

    /// Cached transparency result to avoid expensive bitmap analysis on every render.
    private let isTransparent: Bool

    public init(image: NSImage, size: CGFloat, borderColor: Color = VColor.borderBase, showBorder: Bool = true) {
        self.image = image
        self.size = size
        self.borderColor = borderColor
        self.showBorder = showBorder
        self.isTransparent = Self.imageHasTransparency(image)
    }

    /// Initializer that accepts a precomputed transparency flag, avoiding the expensive
    /// bitmap analysis in `imageHasTransparency`. Use this in animated render paths
    /// where the view is rebuilt frequently (e.g. scale/opacity animations) and the
    /// underlying image doesn't change between frames.
    public init(image: NSImage, size: CGFloat, isTransparent: Bool, borderColor: Color = VColor.borderBase, showBorder: Bool = true) {
        self.image = image
        self.size = size
        self.borderColor = borderColor
        self.showBorder = showBorder
        self.isTransparent = isTransparent
    }

    public var body: some View {
        Image(nsImage: image)
            .interpolation(.none)
            .resizable()
            .aspectRatio(contentMode: isTransparent ? .fit : .fill)
            .frame(width: size, height: size)
            .clipShape(isTransparent ? AnyShape(RoundedRectangle(cornerRadius: 0)) : AnyShape(Circle()))
            .overlay {
                if showBorder && !isTransparent {
                    Circle()
                        .strokeBorder(borderColor, lineWidth: 1)
                }
            }
            .accessibilityHidden(true)
    }

    /// Detect whether an NSImage contains transparent pixels by sampling its bitmap.
    ///
    /// Uses direct `CGImage` pixel access via `CGDataProvider` instead of
    /// `NSImage.tiffRepresentation`, which triggers the full TIFF encoding
    /// pipeline on the main thread (~2000ms for large images).
    ///
    /// Reference: https://developer.apple.com/documentation/appkit/nsimage/cgimage(forproposedRect:context:hints:)
    public static func imageHasTransparency(_ nsImage: NSImage) -> Bool {
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

        let width = cgImage.width
        let height = cgImage.height
        guard width > 0, height > 0 else { return false }

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

        // Sample corners and edge midpoints — same 8 points as before.
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
            if alpha < 242 { // ~0.95 threshold (242/255 ≈ 0.949)
                return true
            }
        }

        return false
    }
}
#endif
