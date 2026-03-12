import SwiftUI

public struct VToolbar<Content: View>: View {
    @ViewBuilder public let content: () -> Content

    public init(@ViewBuilder content: @escaping () -> Content) {
        self.content = content
    }

    public var body: some View {
        HStack(spacing: VSpacing.sm) {
            content()
        }
        .padding(.horizontal, VSpacing.lg)
        .padding(.vertical, VSpacing.sm)
        .background(VColor.surfaceBase)
    }
}

#Preview("VToolbar") {
    ZStack {
        VColor.surfaceOverlay.ignoresSafeArea()
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
