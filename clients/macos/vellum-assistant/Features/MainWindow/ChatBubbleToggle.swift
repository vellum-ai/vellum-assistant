import SwiftUI
import VellumAssistantShared

struct ChatBubbleToggle: View {
    let isActive: Bool
    var tooltip: String? = nil
    let onToggle: () -> Void

    var body: some View {
        VButton(
            label: isActive ? "Hide chat" : "Show chat",
            iconOnly: "bubble.left",
            style: .ghost,
            isActive: isActive,
            tooltip: tooltip,
            action: onToggle
        )
        .foregroundColor(isActive ? VColor.primaryBase : nil)
    }
}

