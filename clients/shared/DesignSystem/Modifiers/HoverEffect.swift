import SwiftUI

public struct HoverEffectModifier: ViewModifier {
    @State private var isHovered = false

    public init() {}

    public func body(content: Content) -> some View {
        content
            .background(isHovered ? VColor.borderBase.opacity(0.5) : .clear)
            .onHover { hovering in
                isHovered = hovering
            }
    }
}

public extension View {
    func vHover() -> some View {
        modifier(HoverEffectModifier())
    }
}

