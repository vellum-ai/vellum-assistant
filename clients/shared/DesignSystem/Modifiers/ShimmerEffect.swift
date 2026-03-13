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

