import SwiftUI

struct NavigationToolbar: View {
    @Binding var activePanel: SidePanelType?

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: VSpacing.sm) {
                // Left group
                VTab(label: "Chat", icon: "bubble.left.fill", isSelected: true, isCloseable: false, onSelect: {})

                Spacer()

                // Right group — labeled buttons
                VIconButton(label: "Generated", icon: "wand.and.stars", isActive: activePanel == .generated) {
                    togglePanel(.generated)
                }
                VIconButton(label: "Agent", icon: "exclamationmark.triangle", isActive: activePanel == .agent) {
                    togglePanel(.agent)
                }
                VIconButton(label: "Control", icon: "gearshape", isActive: activePanel == .control) {
                    togglePanel(.control)
                }

                // Right group — icon-only buttons
                VIconButton(label: "Directory", icon: "doc.text", isActive: activePanel == .directory, iconOnly: true) {
                    togglePanel(.directory)
                }
                VIconButton(label: "Debug", icon: "ant", isActive: activePanel == .debug, iconOnly: true) {
                    togglePanel(.debug)
                }
                VIconButton(label: "Doctor", icon: "stethoscope", isActive: activePanel == .doctor, iconOnly: true) {
                    togglePanel(.doctor)
                }
            }
            .padding(.horizontal, VSpacing.lg)
            .padding(.vertical, VSpacing.sm)
            .background(VColor.backgroundSubtle)

            Divider()
        }
    }

    private func togglePanel(_ panel: SidePanelType) {
        if activePanel == panel {
            activePanel = nil
        } else {
            activePanel = panel
        }
    }
}

#if DEBUG
#Preview("NavigationToolbar") {
    @Previewable @State var panel: SidePanelType? = .control
    NavigationToolbar(activePanel: $panel)
        .frame(width: 700)
}
#endif
