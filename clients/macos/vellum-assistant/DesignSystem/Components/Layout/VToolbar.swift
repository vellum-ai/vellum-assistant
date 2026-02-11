import SwiftUI

struct VToolbar<Content: View>: View {
    @ViewBuilder let content: () -> Content

    var body: some View {
        HStack(spacing: VSpacing.sm) {
            content()
        }
        .padding(.horizontal, VSpacing.lg)
        .padding(.vertical, VSpacing.sm)
        .background(VColor.backgroundSubtle)
    }
}

#Preview("VToolbar") {
    ZStack {
        VColor.background.ignoresSafeArea()
        VToolbar {
            VIconButton(label: "Home", icon: "house") {}
            VIconButton(label: "Search", icon: "magnifyingglass") {}
            VIconButton(label: "Settings", icon: "gear", isActive: true) {}
            Spacer()
            VIconButton(label: "Add", icon: "plus", iconOnly: true) {}
        }
    }
    .frame(width: 500, height: 60)
}
