import SwiftUI

struct VTabBar<Content: View>: View {
    @ViewBuilder let content: () -> Content

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: VSpacing.xs) {
                content()
            }
            .padding(.horizontal, VSpacing.lg)
        }
        .frame(height: 36)
        .background(VColor.backgroundSubtle)
    }
}

#Preview("VTabBar") {
    ZStack {
        VColor.background.ignoresSafeArea()
        VTabBar {
            VTab(label: "Home", icon: "house", isSelected: true, onSelect: {})
            VTab(label: "Sessions", icon: "list.bullet", onSelect: {})
            VTab(label: "Logs", icon: "doc.text", onSelect: {})
        }
    }
    .frame(width: 500, height: 60)
}
