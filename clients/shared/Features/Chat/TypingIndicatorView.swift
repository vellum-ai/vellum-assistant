import SwiftUI

/// Animated three-dot typing bubble shown while the assistant is thinking
/// (before the first token or tool call arrives).
public struct TypingIndicatorView: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private let dotSize: CGFloat = 8
    private let dotSpacing: CGFloat = 5
    private let tickInterval: TimeInterval = 0.18

    public init() {}

    public var body: some View {
        Group {
            if reduceMotion {
                staticDots
            } else {
                TimelineView(.periodic(from: .now, by: tickInterval)) { context in
                    animatedDots(activeIndex: animationPhase(at: context.date))
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

    private func animatedDots(activeIndex: Int) -> some View {
        HStack(spacing: dotSpacing) {
            ForEach(0..<3, id: \.self) { index in
                Circle()
                    .fill(VColor.contentTertiary)
                    .frame(width: dotSize, height: dotSize)
                    .scaleEffect(activeIndex == index ? 1.0 : 0.6)
                    .opacity(activeIndex == index ? 1.0 : 0.45)
            }
        }
        .frame(width: intrinsicDotsWidth, height: dotSize, alignment: .center)
    }

    private var intrinsicDotsWidth: CGFloat {
        dotSize * 3 + dotSpacing * 2
    }

    private func animationPhase(at date: Date) -> Int {
        Int(date.timeIntervalSinceReferenceDate / tickInterval) % 3
    }
}
