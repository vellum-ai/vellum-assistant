import SwiftUI

/// A subtle pulsing indicator for busy/processing state.
/// Displays a gentle opacity pulse when the assistant is actively working,
/// and falls back to a static indicator when reduced motion is enabled.
public struct VBusyIndicator: View {
    public var size: CGFloat = 10
    public var color: Color = VColor.accent

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var isPulsing = false

    public init(size: CGFloat = 10, color: Color = VColor.accent) {
        self.size = size
        self.color = color
    }

    public var body: some View {
        Circle()
            .fill(color)
            .frame(width: size, height: size)
            .opacity(reduceMotion ? 1.0 : (isPulsing ? 0.3 : 1.0))
            .scaleEffect(reduceMotion ? 1.0 : (isPulsing ? 0.85 : 1.0))
            .animation(
                reduceMotion
                    ? nil
                    : .easeInOut(duration: 1.0).repeatForever(autoreverses: true),
                value: isPulsing
            )
            .onAppear {
                if !reduceMotion {
                    isPulsing = true
                }
            }
            .onDisappear {
                isPulsing = false
            }
            .onChange(of: reduceMotion) {
                isPulsing = !reduceMotion
            }
    }
}

#Preview("VBusyIndicator") {
    ZStack {
        VColor.background.ignoresSafeArea()
        VStack(spacing: 24) {
            HStack(spacing: 24) {
                VBusyIndicator(size: 8)
                VBusyIndicator()
                VBusyIndicator(size: 14)
                VBusyIndicator(color: VColor.success)
            }
            HStack(spacing: 24) {
                Text("Reduced motion:")
                    .foregroundColor(VColor.textPrimary)
                Text("(reads @Environment automatically)")
                    .foregroundColor(VColor.textSecondary)
                    .font(VFont.caption)
            }
        }
        .padding()
    }
    .frame(width: 450, height: 150)
}
