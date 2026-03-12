import SwiftUI

public struct VTabBar<Content: View>: View {
    @ViewBuilder public let content: () -> Content

    public init(@ViewBuilder content: @escaping () -> Content) {
        self.content = content
    }

    public var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: VSpacing.xs) {
                content()
            }
            .padding(.horizontal, VSpacing.lg)
        }
        .frame(height: 36)
        .background(VColor.surfaceBase)
    }
}

#Preview("VTabBar") {
    ZStack {
        VColor.surfaceOverlay.ignoresSafeArea()
        VTabBar {
            VTab(label: "Home", icon: "house", isSelected: true, onSelect: {})
            VTab(label: "Sessions", icon: "list.bullet", onSelect: {})
            VTab(label: "Logs", icon: "doc.text", onSelect: {})
        }
    }
    .frame(width: 500, height: 60)
}
