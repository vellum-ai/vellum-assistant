import SwiftUI

/// Onboarding-specific design tokens for the Pixel Meadow theme.
enum Meadow {
    // Panel
    static let panelBackground = Slate._900.opacity(0.75)
    static let panelBorder = Slate._700.opacity(0.4)

    // Egg glow
    static let eggGlow = Amber._500
    static let eggGlowIntense = Amber._400
    static let crackLight = Amber._200

    // Bottom caption
    static let captionText = Color.white.opacity(0.5)

    // Pixel scaling factor
    static let pixelScale: CGFloat = 2.0
}
