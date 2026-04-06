import SwiftUI

public struct CardModifier: ViewModifier {
    public var radius: CGFloat = VRadius.lg
    public var background: Color = VColor.surfaceLift

    public init(radius: CGFloat = VRadius.lg, background: Color = VColor.surfaceLift) {
        self.radius = radius
        self.background = background
    }

    public func body(content: Content) -> some View {
        content
            .background(
                RoundedRectangle(cornerRadius: radius)
                    .fill(background)
            )
            .overlay(
                RoundedRectangle(cornerRadius: radius)
                    .strokeBorder(VColor.borderHover, lineWidth: 1)
                    .allowsHitTesting(false)
            )
    }
}

public extension View {
    func vCard(radius: CGFloat = VRadius.lg, background: Color = VColor.surfaceLift) -> some View {
        modifier(CardModifier(radius: radius, background: background))
    }
}

