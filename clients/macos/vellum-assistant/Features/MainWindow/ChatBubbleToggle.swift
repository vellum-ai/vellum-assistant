import SwiftUI
import VellumAssistantShared

struct ChatBubbleToggle: View {
    let isActive: Bool
    var tooltip: String? = nil
    let onToggle: () -> Void

    var body: some View {
        VIconButton(
            label: isActive ? "Hide chat" : "Show chat",
            icon: "bubble.left",
            isActive: isActive,
            iconOnly: true,
            tooltip: tooltip,
            action: onToggle
        )
        .foregroundColor(isActive ? VColor.primaryBase : nil)
    }
}

#Preview("ChatBubbleToggle") {
    ZStack {
        VColor.surfaceOverlay.ignoresSafeArea()
        HStack(spacing: 16) {
            ChatBubbleToggle(isActive: false, onToggle: {})
            ChatBubbleToggle(isActive: true, onToggle: {})
        }
        .padding()
    }
    .frame(width: 200, height: 80)
}
