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

