import SwiftUI
import VellumAssistantShared

struct NavBar: View {
    @Binding var sidebarOpen: Bool
    let sidebarVisible: Bool
    let onSettings: () -> Void

    /// Leading padding to account for macOS traffic light buttons.
    private let trafficLightPadding: CGFloat = 78

    var body: some View {
        ZStack {
            // Center: title
            Text("Vellum")
                .font(VFont.bodyMedium)
                .foregroundColor(VColor.textSecondary)

            HStack(spacing: VSpacing.xs) {
                // Left group
                if sidebarVisible {
                    VIconButton(label: "Threads", icon: "sidebar.left", isActive: sidebarOpen, iconOnly: true) {
                        withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) {
                            sidebarOpen.toggle()
                        }
                    }
                }

                Spacer()

                // Right group
                VIconButton(label: "Settings", icon: "gearshape", iconOnly: true) {
                    onSettings()
                }
            }
            .padding(.leading, trafficLightPadding)
            .padding(.trailing, VSpacing.lg)
        }
        .frame(height: 36)
        .background(VColor.background)
        .shadow(color: .black.opacity(0.08), radius: 3, y: 2)
    }
}

#if DEBUG
struct NavBar_Preview: PreviewProvider {
    static var previews: some View {
        NavBarPreviewWrapper()
            .frame(width: 700)
            .previewDisplayName("NavBar")
    }
}

private struct NavBarPreviewWrapper: View {
    @State private var sidebarOpen = false

    var body: some View {
        VStack(spacing: 0) {
            NavBar(
                sidebarOpen: $sidebarOpen,
                sidebarVisible: true,
                onSettings: {}
            )
            Spacer()
        }
        .background(VColor.backgroundSubtle)
    }
}
#endif
