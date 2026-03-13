import SwiftUI
import VellumAssistantShared

struct TemporaryChatToggle: View {
    let isActive: Bool
    var tooltip: String? = nil
    let onToggle: () -> Void

    var body: some View {
        VIconButton(
            label: isActive ? "Turn off temporary chat" : "Turn on temporary chat",
            icon: "circle.dashed",
            isActive: isActive,
            iconOnly: true,
            tooltip: tooltip,
            action: onToggle
        )
        .foregroundColor(isActive ? VColor.primaryBase : nil)
    }
}

