import SwiftUI

/// Onboarding-specific design tokens for the Pixel Meadow theme.
public enum Meadow {
    // Panel
    public static let panelBackground = adaptiveColor(
        light: Color.white.opacity(0.85),
        dark: Moss._900.opacity(0.75)
    )
    public static let panelBorder = adaptiveColor(
        light: Stone._200.opacity(0.6),
        dark: Moss._700.opacity(0.4)
    )

    // Egg glow
    public static let eggGlow = Amber._500
    public static let eggGlowIntense = Amber._400
    public static let crackLight = Amber._200

    // Bottom caption
    public static let captionText = adaptiveColor(
        light: Color.black.opacity(0.4),
        dark: Color.white.opacity(0.5)
    )

    // Pixel scaling factor
    public static let pixelScale: CGFloat = 2.0

    // Art pixel size — each pixel-art cell renders as this many points
    public static let artPixelSize: CGFloat = 5.0

    // Interview palette
    public static let avatarGradientStart = Sage._600
    public static let avatarGradientEnd = Sage._400
    public static let userBubbleGradientStart = Sage._600
    public static let userBubbleGradientEnd = Sage._400
}
