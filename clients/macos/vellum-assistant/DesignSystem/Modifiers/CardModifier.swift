import SwiftUI

struct CardModifier: ViewModifier {
    var radius: CGFloat = VRadius.md

    func body(content: Content) -> some View {
        content
            .background(VColor.surface)
            .clipShape(RoundedRectangle(cornerRadius: radius))
            .overlay(
                RoundedRectangle(cornerRadius: radius)
                    .stroke(VColor.surfaceBorder, lineWidth: 1)
            )
    }
}

extension View {
    func vCard(radius: CGFloat = VRadius.md) -> some View {
        modifier(CardModifier(radius: radius))
    }
}

#Preview("CardModifier") {
    ZStack {
        VColor.background.ignoresSafeArea()
        HStack(spacing: 16) {
            Text("xs").padding().vCard(radius: VRadius.xs)
            Text("md").padding().vCard(radius: VRadius.md)
            Text("xl").padding().vCard(radius: VRadius.xl)
        }
        .foregroundColor(VColor.textPrimary)
        .padding()
    }
    .frame(width: 400, height: 120)
}
