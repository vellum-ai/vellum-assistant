import SwiftUI

/// Animated three-dot typing bubble shown while the assistant is thinking
/// (before the first token or tool call arrives).
public struct TypingIndicatorView: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private let dotSize: CGFloat = 8
    private let dotSpacing: CGFloat = 5
    private let animationSpeed: Double = 2.0 * .pi / 1.0

    public init() {}

    public var body: some View {
        Group {
            if reduceMotion {
                staticDots
            } else {
                TimelineView(.animation) { context in
                    animatedDots(at: context.date)
                }
            }
        }
        .padding(.horizontal, VSpacing.md)
        .padding(.vertical, VSpacing.sm)
        .background(
            RoundedRectangle(cornerRadius: VRadius.lg)
                .fill(VColor.surfaceOverlay)
        )
        .fixedSize()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Assistant is thinking")
    }

    private var staticDots: some View {
        HStack(spacing: dotSpacing) {
            ForEach(0..<3, id: \.self) { _ in
                Circle()
                    .fill(VColor.contentTertiary)
                    .frame(width: dotSize, height: dotSize)
                    .opacity(0.7)
            }
        }
        .frame(width: intrinsicDotsWidth, height: dotSize, alignment: .center)
    }

    private func animatedDots(at date: Date) -> some View {
        let phase = date.timeIntervalSinceReferenceDate * animationSpeed

        return HStack(spacing: dotSpacing) {
            ForEach(0..<3, id: \.self) { index in
                let offset = -Double(index) * (2.0 * .pi / 3.0)
                let wave = (sin(phase + offset) + 1.0) / 2.0

                Circle()
                    .fill(VColor.contentTertiary)
                    .frame(width: dotSize, height: dotSize)
                    .scaleEffect(0.6 + 0.4 * wave)
                    .opacity(0.45 + 0.55 * wave)
            }
        }
        .frame(width: intrinsicDotsWidth, height: dotSize, alignment: .center)
    }

    private var intrinsicDotsWidth: CGFloat {
        dotSize * 3 + dotSpacing * 2
    }
}
