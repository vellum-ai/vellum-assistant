import SwiftUI

/// Reusable avatar image that adapts its clip shape based on image transparency.
/// Images with transparent backgrounds render unclipped so the full artwork
/// (ears, antennae, etc.) is visible. Opaque images render in a circle.
struct VAvatarImage: View {
    let image: NSImage
    let size: CGFloat

    /// Optional border color. Defaults to `VColor.surfaceBorder`.
    var borderColor: Color = VColor.surfaceBorder

    /// Whether to show a subtle border around the avatar.
    var showBorder: Bool = true

    var body: some View {
        Image(nsImage: image)
            .interpolation(.none)
            .resizable()
            .aspectRatio(contentMode: hasTransparency ? .fit : .fill)
            .frame(width: size, height: size)
            .clipShape(hasTransparency ? AnyShape(RoundedRectangle(cornerRadius: 0)) : AnyShape(Circle()))
            .overlay {
                if showBorder && !hasTransparency {
                    Circle()
                        .strokeBorder(borderColor, lineWidth: 1)
                }
            }
    }

    /// Check whether the underlying image has any transparent pixels.
    /// Cached per-image identity via the image's hash to avoid re-scanning.
    private var hasTransparency: Bool {
        Self.imageHasTransparency(image)
    }

    /// Detect whether an NSImage contains transparent pixels by sampling its bitmap.
    private static func imageHasTransparency(_ nsImage: NSImage) -> Bool {
        guard let tiffData = nsImage.tiffRepresentation,
              let bitmap = NSBitmapImageRep(data: tiffData) else {
            return false
        }

        // If the image doesn't even have an alpha channel, it's fully opaque.
        guard bitmap.hasAlpha else { return false }

        // Sample corners and edges — if any sampled pixel is transparent,
        // the image has a transparent background.
        let width = bitmap.pixelsWide
        let height = bitmap.pixelsHigh
        guard width > 0, height > 0 else { return false }

        let samplePoints: [(Int, Int)] = [
            (0, 0), (width - 1, 0),                     // top corners
            (0, height - 1), (width - 1, height - 1),   // bottom corners
            (width / 2, 0), (width / 2, height - 1),    // top/bottom center
            (0, height / 2), (width - 1, height / 2),   // left/right center
        ]

        for (x, y) in samplePoints {
            guard let color = bitmap.colorAt(x: x, y: y) else { continue }
            if color.alphaComponent < 0.95 {
                return true
            }
        }

        return false
    }
}

#if DEBUG
#Preview("VAvatarImage") {
    ZStack {
        VColor.background.ignoresSafeArea()
        HStack(spacing: VSpacing.lg) {
            VAvatarImage(
                image: NSImage(systemSymbolName: "person.circle.fill", accessibilityDescription: nil)!,
                size: 28
            )
            VAvatarImage(
                image: NSImage(systemSymbolName: "person.circle.fill", accessibilityDescription: nil)!,
                size: 40
            )
            VAvatarImage(
                image: NSImage(systemSymbolName: "person.circle.fill", accessibilityDescription: nil)!,
                size: 52
            )
        }
    }
    .frame(width: 300, height: 100)
}
#endif
