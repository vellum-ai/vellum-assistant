import SwiftUI

struct HoverEffectModifier: ViewModifier {
    @State private var isHovered = false

    func body(content: Content) -> some View {
        content
            .background(isHovered ? VColor.surfaceBorder.opacity(0.5) : .clear)
            .onHover { hovering in
                isHovered = hovering
            }
    }
}

extension View {
    func vHover() -> some View {
        modifier(HoverEffectModifier())
    }
}
