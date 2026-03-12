import SwiftUI

/// Sweeps a translucent `LinearGradient` highlight left-to-right across the
/// modified view, creating a "shimmer" skeleton-loading effect.
///
/// Respects `accessibilityReduceMotion` — falls back to a static appearance.
public struct ShimmerEffectModifier: ViewModifier {
    public var highlightColor: Color
    public var duration: TimeInterval

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var phase: CGFloat = -1

    public init(
        highlightColor: Color = VColor.surfaceBase,
        duration: TimeInterval = 1.5
    ) {
        self.highlightColor = highlightColor
        self.duration = duration
    }

    public func body(content: Content) -> some View {
        content
            .overlay {
                if !reduceMotion {
                    GeometryReader { geometry in
                        let width = geometry.size.width

                        LinearGradient(
                            colors: [
                                .clear,
                                highlightColor.opacity(0.4),
                                highlightColor.opacity(0.7),
                                highlightColor.opacity(0.4),
                                .clear,
                            ],
                            startPoint: .leading,
                            endPoint: .trailing
                        )
                        .frame(width: width * 0.6)
                        .offset(x: phase * (width * 1.6))
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .clipped()
                }
            }
            .onAppear {
                guard !reduceMotion else { return }
                withAnimation(
                    .linear(duration: duration)
                        .repeatForever(autoreverses: false)
                ) {
                    phase = 1
                }
            }
    }
}

public extension View {
    func vShimmer(
        highlightColor: Color = VColor.surfaceBase,
        duration: TimeInterval = 1.5
    ) -> some View {
        modifier(ShimmerEffectModifier(
            highlightColor: highlightColor,
            duration: duration
        ))
    }
}

#Preview("ShimmerEffect") {
    ZStack {
        VColor.surfaceOverlay.ignoresSafeArea()
        VStack(spacing: VSpacing.lg) {
            RoundedRectangle(cornerRadius: VRadius.sm)
                .fill(VColor.borderBase.opacity(0.5))
                .frame(width: 200, height: 14)
                .vShimmer()

            RoundedRectangle(cornerRadius: VRadius.md)
                .fill(VColor.borderBase.opacity(0.5))
                .frame(width: 300, height: 40)
                .vShimmer()

            RoundedRectangle(cornerRadius: VRadius.lg)
                .fill(VColor.borderBase.opacity(0.5))
                .frame(height: 80)
                .vShimmer()
        }
        .padding()
    }
    .frame(width: 400, height: 250)
}
