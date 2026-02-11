import SwiftUI

struct VCard<Content: View>: View {
    var padding: CGFloat = VSpacing.xl
    @ViewBuilder let content: () -> Content

    var body: some View {
        content()
            .padding(padding)
            .background(VColor.surface)
            .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
            .overlay(
                RoundedRectangle(cornerRadius: VRadius.md)
                    .stroke(VColor.surfaceBorder, lineWidth: 1)
            )
    }
}
