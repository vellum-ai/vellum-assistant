import SwiftUI

/// Size presets for `VAppIcon`, matching common app icon sizes.
public enum VAppIconSize {
    case small   // 32pt
    case medium  // 64pt
    case large   // 96pt

    /// The point dimension of the icon.
    public var dimension: CGFloat {
        switch self {
        case .small: return 32
        case .medium: return 64
        case .large: return 96
        }
    }

    /// Corner radius proportional to size (~22% of width, like iOS icons).
    var cornerRadius: CGFloat {
        dimension * 0.22
    }

    /// SF Symbol font size, proportional to icon size.
    var symbolSize: CGFloat {
        switch self {
        case .small: return 14
        case .medium: return 28
        case .large: return 42
        }
    }
}

/// An iOS-style app icon: an SF Symbol centered on a gradient rounded-rect background.
public struct VAppIcon: View {
    let sfSymbol: String
    let gradientColors: [String]
    let size: VAppIconSize

    public init(sfSymbol: String, gradientColors: [String], size: VAppIconSize = .medium) {
        self.sfSymbol = sfSymbol
        self.gradientColors = gradientColors
        self.size = size
    }

    private var gradient: LinearGradient {
        let colors: [Color] = gradientColors.map { Color(hexString: $0) }
        // Fall back to a single-color gradient if only one color is provided
        let resolvedColors = colors.count >= 2 ? colors : [colors.first ?? .gray, colors.first ?? .gray]
        return LinearGradient(
            colors: resolvedColors,
            startPoint: .topLeading,
            endPoint: .bottomTrailing
        )
    }

    public var body: some View {
        ZStack {
            // Gradient background
            RoundedRectangle(cornerRadius: size.cornerRadius, style: .continuous)
                .fill(gradient)

            // Subtle inner shadow for depth
            RoundedRectangle(cornerRadius: size.cornerRadius, style: .continuous)
                .stroke(Color.white.opacity(0.25), lineWidth: size == .small ? 0.5 : 1)
                .blendMode(.overlay)

            // Subtle top highlight for gloss effect
            RoundedRectangle(cornerRadius: size.cornerRadius, style: .continuous)
                .fill(
                    LinearGradient(
                        colors: [Color.white.opacity(0.2), Color.clear],
                        startPoint: .top,
                        endPoint: .center
                    )
                )

            // SF Symbol
            Image(systemName: sfSymbol)
                .font(.system(size: size.symbolSize, weight: .medium))
                .foregroundColor(.white)
                .shadow(color: Color.black.opacity(0.2), radius: 1, x: 0, y: 1)
        }
        .frame(width: size.dimension, height: size.dimension)
        .shadow(color: Color.black.opacity(0.15), radius: size == .small ? 2 : 4, x: 0, y: 2)
        .accessibilityLabel("App icon: \(sfSymbol)")
    }
}

#Preview("VAppIcon") {
    ZStack {
        VColor.background.ignoresSafeArea()
        HStack(spacing: VSpacing.xl) {
            VAppIcon(
                sfSymbol: "chart.line.uptrend.xyaxis",
                gradientColors: ["#7C3AED", "#4F46E5"],
                size: .small
            )
            VAppIcon(
                sfSymbol: "globe",
                gradientColors: ["#059669", "#10B981"],
                size: .medium
            )
            VAppIcon(
                sfSymbol: "camera",
                gradientColors: ["#E11D48", "#F43F5E"],
                size: .large
            )
        }
        .padding()
    }
    .frame(width: 400, height: 200)
}
