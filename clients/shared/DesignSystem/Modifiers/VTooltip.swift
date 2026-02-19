import SwiftUI

/// A custom tooltip modifier that shows a styled tooltip after a hover delay.
public struct VTooltipModifier: ViewModifier {
    let text: String
    let delay: TimeInterval

    @State private var isHovered = false
    @State private var isVisible = false
    @State private var hoverTask: DispatchWorkItem?

    public init(_ text: String, delay: TimeInterval = 1.0) {
        self.text = text
        self.delay = delay
    }

    public func body(content: Content) -> some View {
        content
            .onHover { hovering in
                isHovered = hovering
                hoverTask?.cancel()
                if hovering {
                    let task = DispatchWorkItem {
                        withAnimation(VAnimation.fast) { isVisible = true }
                    }
                    hoverTask = task
                    DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: task)
                } else {
                    withAnimation(VAnimation.fast) { isVisible = false }
                }
            }
            .overlay(alignment: .bottom) {
                if isVisible && !text.isEmpty {
                    Text(text)
                        .font(VFont.caption)
                        .foregroundColor(VColor.textPrimary)
                        .padding(.horizontal, VSpacing.sm)
                        .padding(.vertical, VSpacing.xs)
                        .background(VColor.surface)
                        .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
                        .overlay(
                            RoundedRectangle(cornerRadius: VRadius.sm)
                                .stroke(VColor.surfaceBorder, lineWidth: 1)
                        )
                        .shadow(color: .black.opacity(0.15), radius: 4, y: 2)
                        .fixedSize()
                        .offset(y: 4)
                        .offset(y: 28)
                        .allowsHitTesting(false)
                        .transition(.opacity)
                        .zIndex(1000)
                }
            }
            .onDisappear {
                hoverTask?.cancel()
                isVisible = false
            }
    }
}

public extension View {
    /// Shows a custom tooltip on hover with a 1s delay.
    func vTooltip(_ text: String, delay: TimeInterval = 1.0) -> some View {
        modifier(VTooltipModifier(text, delay: delay))
    }
}
