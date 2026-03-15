import SwiftUI

public struct CardModifier: ViewModifier {
    public var radius: CGFloat = VRadius.lg
    public var background: Color = VColor.surfaceBase

    public init(radius: CGFloat = VRadius.lg, background: Color = VColor.surfaceBase) {
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
                    .strokeBorder(VColor.borderDisabled, lineWidth: 2)
                    .allowsHitTesting(false)
            )
    }
}

public extension View {
    func vCard(radius: CGFloat = VRadius.lg, background: Color = VColor.surfaceBase) -> some View {
        modifier(CardModifier(radius: radius, background: background))
    }
}

