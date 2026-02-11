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
