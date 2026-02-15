import VellumAssistantShared
import SwiftUI

struct NavigationToolbar: View {
    @Binding var activePanel: SidePanelType?
    @Binding var contentMode: ContentMode
    var isChatPoppedOut: Bool = false
    var onPopOutChat: (() -> Void)?
    var onDockChat: (() -> Void)?

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: VSpacing.sm) {
                // Left group -- content mode toggle
                ContentModeToggle(contentMode: $contentMode)

                // Pop-out / dock button for chat mode
                if contentMode == .chat {
                    VIconButton(
                        label: isChatPoppedOut ? "Dock Chat" : "Pop Out Chat",
                        icon: isChatPoppedOut ? "rectangle.center.inset.filled" : "rectangle.portrait.on.rectangle.portrait",
                        isActive: isChatPoppedOut,
                        iconOnly: true
                    ) {
                        if isChatPoppedOut {
                            onDockChat?()
                        } else {
                            onPopOutChat?()
                        }
                    }
                }

                Spacer()

                // Right group — labeled buttons
                VIconButton(label: "Agent", icon: "exclamationmark.triangle", isActive: activePanel == .agent) {
                    togglePanel(.agent)
                }
                VIconButton(label: "Settings", icon: "gearshape", isActive: activePanel == .settings) {
                    togglePanel(.settings)
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
            .padding(.bottom, VSpacing.sm)
            .background(VColor.background)
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
struct NavigationToolbar_Preview: PreviewProvider {
    static var previews: some View {
        NavigationToolbarPreviewWrapper()
            .frame(width: 700)
            .previewDisplayName("NavigationToolbar")
    }
}

private struct NavigationToolbarPreviewWrapper: View {
    @State private var panel: SidePanelType? = .settings
    @State private var mode: ContentMode = .dashboard

    var body: some View {
        NavigationToolbar(activePanel: $panel, contentMode: $mode)
    }
}
#endif
