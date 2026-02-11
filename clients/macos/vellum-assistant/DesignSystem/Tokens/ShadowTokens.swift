import SwiftUI

/// Shadow presets. Apply via `.vShadow(.md)` or `.shadow(color:radius:y:)`.
enum VShadow {
    struct Definition {
        let color: Color
        let radius: CGFloat
        let x: CGFloat
        let y: CGFloat
    }

    static let sm   = Definition(color: .black.opacity(0.2), radius: 4, x: 0, y: 2)
    static let md   = Definition(color: .black.opacity(0.3), radius: 8, x: 0, y: 4)
    static let lg   = Definition(color: .black.opacity(0.4), radius: 16, x: 0, y: 8)

    /// Amber glow effect for brand elements (orb, highlights)
    static let glow = Definition(color: Amber._500.opacity(0.3), radius: 12, x: 0, y: 0)

    /// Violet glow for accent elements (focused inputs, active buttons)
    static let accentGlow = Definition(color: Violet._600.opacity(0.3), radius: 8, x: 0, y: 0)
}

extension View {
    func vShadow(_ definition: VShadow.Definition) -> some View {
        shadow(color: definition.color, radius: definition.radius, x: definition.x, y: definition.y)
    }
}
