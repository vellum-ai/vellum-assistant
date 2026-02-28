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
            .background(VColor.surface)
            .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
            .overlay(
                RoundedRectangle(cornerRadius: VRadius.md)
                    .stroke(VColor.surfaceBorder, lineWidth: 1)
            )
    }
}

#Preview("VCard") {
    ZStack {
        VColor.background.ignoresSafeArea()
        VStack(spacing: 16) {
            VCard {
                Text("Default padding")
                    .foregroundColor(VColor.textPrimary)
            }
            VCard(padding: VSpacing.sm) {
                Text("Small padding")
                    .foregroundColor(VColor.textPrimary)
            }
            VCard(padding: VSpacing.xxxl) {
                Text("Large padding")
                    .foregroundColor(VColor.textPrimary)
            }
        }
        .padding()
    }
    .frame(width: 300, height: 300)
}
