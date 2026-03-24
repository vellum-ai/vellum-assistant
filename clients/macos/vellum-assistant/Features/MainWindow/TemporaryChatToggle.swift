import SwiftUI
import VellumAssistantShared

struct TemporaryChatToggle: View {
    let isActive: Bool
    var tooltip: String? = nil
    let onToggle: () -> Void

    var body: some View {
        VButton(
            label: isActive ? "Turn off temporary chat" : "Turn on temporary chat",
            iconOnly: "circle.dashed",
            style: .ghost,
            isActive: isActive,
            tooltip: tooltip,
            action: onToggle
        )
        .foregroundStyle(isActive ? VColor.primaryBase : nil)
    }
}

