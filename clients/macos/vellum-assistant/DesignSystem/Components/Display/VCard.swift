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
