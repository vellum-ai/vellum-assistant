import SwiftUI
import VellumAssistantShared

struct TemporaryChatIndicator: View {
    let onExit: () -> Void

    @State private var isHovered = false

    var body: some View {
        Button(action: onExit) {
            HStack(spacing: VSpacing.xs) {
                Image(systemName: "circle.dashed")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundColor(VColor.accent)
                Text("Temporary")
                    .font(VFont.caption)
                Image(systemName: "xmark")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundColor(isHovered ? VColor.textSecondary : VColor.textMuted)
            }
        }
        .buttonStyle(TemporaryChatIndicatorStyle(isHovered: isHovered))
        .onHover { hovering in
            isHovered = hovering
            if hovering { NSCursor.pointingHand.set() }
            else { NSCursor.arrow.set() }
        }
        .accessibilityLabel("Exit temporary chat")
    }
}

private struct TemporaryChatIndicatorStyle: ButtonStyle {
    let isHovered: Bool

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundColor(VColor.textPrimary)
            .padding(.horizontal, VSpacing.md)
            .padding(.vertical, VSpacing.buttonV)
            .background(backgroundColor(isPressed: configuration.isPressed))
            .clipShape(RoundedRectangle(cornerRadius: VRadius.pill))
            .contentShape(RoundedRectangle(cornerRadius: VRadius.pill))
            .overlay(
                RoundedRectangle(cornerRadius: VRadius.pill)
                    .stroke(VColor.textSecondary, lineWidth: 1)
            )
            .animation(VAnimation.fast, value: configuration.isPressed)
            .animation(VAnimation.fast, value: isHovered)
    }

    private func backgroundColor(isPressed: Bool) -> Color {
        if isPressed { return VColor.ghostPressed }
        if isHovered { return VColor.ghostHover }
        return VColor.surfaceBorder
    }
}

#Preview("TemporaryChatIndicator") {
    ZStack {
        VColor.background.ignoresSafeArea()
        TemporaryChatIndicator(onExit: {})
            .padding()
    }
    .frame(width: 250, height: 80)
}
