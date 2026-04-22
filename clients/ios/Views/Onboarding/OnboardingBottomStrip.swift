#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

/// Decorative botanical strip for the bottom edge of onboarding screens.
///
/// Pair with `.ignoresSafeArea(.container, edges: .bottom)` at the call
/// site so the strip bleeds past the home indicator.
struct OnboardingBottomStrip: View {
    /// Intrinsic height. Exposed so callers can reserve matching space
    /// above the strip without duplicating the literal.
    static let height: CGFloat = 88

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .bottom) {
                // Soft "ground" band behind the foliage.
                LinearGradient(
                    colors: [
                        Color(hex: 0xEFF3DF),
                        Color(hex: 0xDCE7C8),
                        Color(hex: 0xEFF3DF),
                    ],
                    startPoint: .leading,
                    endPoint: .trailing
                )
                .frame(height: 26)

                HStack(alignment: .bottom, spacing: 0) {
                    ForEach(Array(clusterOrder(width: geo.size.width).enumerated()), id: \.offset) { _, accent in
                        PlantCluster(accent: accent)
                            .frame(maxWidth: .infinity, alignment: .bottom)
                    }
                }
                .padding(.horizontal, VSpacing.lg)
            }
            .frame(width: geo.size.width, height: geo.size.height, alignment: .bottom)
        }
        .frame(height: Self.height)
        .accessibilityHidden(true)
    }

    private func clusterOrder(width: CGFloat) -> [FlowerAccent] {
        // Tile 4 clusters on typical phone widths; widen to 5 on larger phones
        // so the strip keeps an organic density rather than stretching gaps.
        let base: [FlowerAccent] = [.pink, .orange, .yellow, .pink]
        return width > 420 ? base + [.orange] : base
    }
}

// MARK: - Components

private enum FlowerAccent {
    case pink, orange, yellow

    var color: Color {
        switch self {
        case .pink:   return Color(hex: 0xE9A8B3)
        case .orange: return Color(hex: 0xE8A66A)
        case .yellow: return Color(hex: 0xE9C368)
        }
    }
}

private struct PlantCluster: View {
    let accent: FlowerAccent

    var body: some View {
        ZStack(alignment: .bottom) {
            Leaf(color: Color(hex: 0x4F8256), height: 54)
                .rotationEffect(.degrees(-14), anchor: .bottom)
                .offset(x: -10)

            Leaf(color: Color(hex: 0x7BA775), height: 42)
                .rotationEffect(.degrees(16), anchor: .bottom)
                .offset(x: 10)

            Leaf(color: Color(hex: 0x23793D), height: 48)
                .rotationEffect(.degrees(2), anchor: .bottom)
                .offset(y: -2)

            Flower(color: accent.color)
                .offset(y: -40)
        }
        .frame(width: 56, height: 80, alignment: .bottom)
    }
}

private struct Leaf: View {
    let color: Color
    let height: CGFloat

    var body: some View {
        Capsule()
            .fill(
                LinearGradient(
                    colors: [color.opacity(0.95), color.opacity(0.75)],
                    startPoint: .top,
                    endPoint: .bottom
                )
            )
            .frame(width: height * 0.36, height: height)
    }
}

private struct Flower: View {
    let color: Color

    var body: some View {
        ZStack {
            ForEach(0..<5, id: \.self) { index in
                let angle = Double(index) * (2 * .pi / 5)
                Circle()
                    .fill(color)
                    .frame(width: 12, height: 12)
                    .offset(
                        x: CGFloat(cos(angle)) * 8,
                        y: CGFloat(sin(angle)) * 8
                    )
            }
            Circle()
                .fill(Color(hex: 0xE9C368))
                .frame(width: 7, height: 7)
        }
        .frame(width: 28, height: 28)
    }
}
#endif
