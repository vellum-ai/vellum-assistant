import SwiftUI

/// A subtle pulsing indicator for busy/processing state.
/// Displays a gentle opacity and scale pulse when the assistant is actively working,
/// and falls back to a static indicator when reduced motion is enabled.
///
/// Uses `phaseAnimator` so the animation lifecycle is fully managed by SwiftUI
/// and does not depend on `@State`. This prevents the animation from restarting
/// when parent views re-evaluate their body or when `ViewThatFits` switches
/// between layout variants — both of which destroy and recreate child `@State`.
///
/// Reference: https://developer.apple.com/documentation/swiftui/phaseanimator
public struct VBusyIndicator: View {
    public var size: CGFloat = 10
    public var color: Color = VColor.primaryBase

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(size: CGFloat = 10, color: Color = VColor.primaryBase) {
        self.size = size
        self.color = color
    }

    public var body: some View {
        Circle()
            .fill(color)
            .frame(width: size, height: size)
            .phaseAnimator(
                reduceMotion ? [false] : [false, true]
            ) { content, phase in
                content
                    .opacity(phase ? 0.3 : 1.0)
                    .scaleEffect(phase ? 0.85 : 1.0)
            } animation: { _ in
                .easeInOut(duration: 1.0)
            }
    }
}

