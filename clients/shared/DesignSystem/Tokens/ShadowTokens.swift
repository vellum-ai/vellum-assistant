import SwiftUI

/// Shadow presets. Apply via `.vShadow(.md)` or `.shadow(color:radius:y:)`.
public enum VShadow {
    public struct Definition {
        public let color: Color
        public let radius: CGFloat
        public let x: CGFloat
        public let y: CGFloat

        public init(color: Color, radius: CGFloat, x: CGFloat, y: CGFloat) {
            self.color = color
            self.radius = radius
            self.x = x
            self.y = y
        }
    }

    public static let sm   = Definition(color: VColor.auxBlack.opacity(0.2), radius: 4, x: 0, y: 2)
    public static let md   = Definition(color: VColor.auxBlack.opacity(0.3), radius: 8, x: 0, y: 4)
    public static let lg   = Definition(color: VColor.auxBlack.opacity(0.4), radius: 16, x: 0, y: 8)

    /// Amber glow effect for brand elements (orb, highlights)
    public static let glow = Definition(color: VColor.systemNegativeHover.opacity(0.3), radius: 12, x: 0, y: 0)

    /// Forest glow for accent elements (focused inputs, active buttons)
    public static let accentGlow = Definition(color: VColor.primaryActive.opacity(0.3), radius: 8, x: 0, y: 0)
}

public extension View {
    func vShadow(_ definition: VShadow.Definition) -> some View {
        shadow(color: definition.color, radius: definition.radius, x: definition.x, y: definition.y)
    }
}
