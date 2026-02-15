import SwiftUI

/// Onboarding-specific design tokens for the Pixel Meadow theme.
public enum Meadow {
    // Panel
    public static let panelBackground = Slate._900.opacity(0.75)
    public static let panelBorder = Slate._700.opacity(0.4)

    // Egg glow
    public static let eggGlow = Amber._500
    public static let eggGlowIntense = Amber._400
    public static let crackLight = Amber._200

    // Bottom caption
    public static let captionText = Color.white.opacity(0.5)

    // Pixel scaling factor
    public static let pixelScale: CGFloat = 2.0

    // Art pixel size — each pixel-art cell renders as this many points
    public static let artPixelSize: CGFloat = 5.0

    // Interview palette
    public static let avatarGradientStart = Violet._600
    public static let avatarGradientEnd = Violet._400
    public static let userBubbleGradientStart = Violet._600
    public static let userBubbleGradientEnd = Violet._400
}
