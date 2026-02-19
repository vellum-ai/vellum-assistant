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
        .foregroundColor(isActive ? VColor.accent : nil)
    }
}

#Preview("TemporaryChatToggle") {
    ZStack {
        VColor.background.ignoresSafeArea()
        HStack(spacing: 16) {
            TemporaryChatToggle(isActive: false, onToggle: {})
            TemporaryChatToggle(isActive: true, onToggle: {})
        }
        .padding()
    }
    .frame(width: 200, height: 80)
}
