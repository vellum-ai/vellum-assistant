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

