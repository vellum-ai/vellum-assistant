import SwiftUI

/// Animated three-dot typing bubble shown while the assistant is thinking
/// (before the first token or tool call arrives).
public struct TypingIndicatorView: View {
    @State private var animate = false

    public init() {}

    public var body: some View {
        HStack(spacing: 5) {
            ForEach(0..<3, id: \.self) { index in
                Circle()
                    .fill(VColor.contentTertiary)
                    .frame(width: 8, height: 8)
                    .scaleEffect(animate ? 1.0 : 0.5)
                    .animation(
                        .easeInOut(duration: 0.5)
                            .repeatForever(autoreverses: true)
                            .delay(Double(index) * 0.18),
                        value: animate
                    )
            }
        }
        .padding(.horizontal, VSpacing.md)
        .padding(.vertical, VSpacing.sm)
        .background(
            RoundedRectangle(cornerRadius: VRadius.lg)
                .fill(VColor.surfaceOverlay)
        )
        // Isolate the repeatForever scale animation from parent geometry
        // changes. Without this barrier, LazyVStack repositioning or outer
        // .frame(width:) resize (containerWidth 0→actual) gets captured by
        // the persistent animation context, causing the dots to bounce in
        // position instead of just pulsing in scale.
        .geometryGroup()
        .onAppear {
            animate = true
        }
        .onDisappear {
            animate = false
        }
    }
}
