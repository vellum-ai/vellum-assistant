import SwiftUI

public struct VCard<Content: View>: View {
    public var padding: CGFloat = VSpacing.xl
    @ViewBuilder public let content: () -> Content

    public init(padding: CGFloat = VSpacing.xl, @ViewBuilder content: @escaping () -> Content) {
        self.padding = padding
        self.content = content
    }

    public var body: some View {
        content()
            .padding(padding)
            .background(VColor.surfaceBase)
            .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
            .overlay(
                RoundedRectangle(cornerRadius: VRadius.md)
                    .stroke(VColor.borderBase, lineWidth: 1)
            )
    }
}

