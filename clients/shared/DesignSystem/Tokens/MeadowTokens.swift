import SwiftUI

/// Onboarding-specific design tokens for the Pixel Meadow theme.
public enum Meadow {
    // Panel
    public static let panelBackground = adaptiveColor(
        light: VColor.auxWhite.opacity(0.85),
        dark: VColor.surfaceOverlay.opacity(0.75)
    )
    public static let panelBorder = adaptiveColor(
        light: VColor.surfaceBase.opacity(0.6),
        dark: VColor.surfaceActive.opacity(0.4)
    )

    // Egg glow
    public static let eggGlow = VColor.systemNegativeHover
    public static let eggGlowIntense = VColor.systemNegativeHover
    public static let crackLight = VColor.systemNegativeWeak

    // Bottom caption
    public static let captionText = adaptiveColor(
        light: VColor.auxBlack.opacity(0.4),
        dark: VColor.auxWhite.opacity(0.5)
    )

    // Pixel scaling factor
    public static let pixelScale: CGFloat = 2.0

    // Art pixel size — each pixel-art cell renders as this many points
    public static let artPixelSize: CGFloat = 5.0

    // Interview palette
    public static let avatarGradientStart = VColor.primaryBase
    public static let avatarGradientEnd = VColor.systemPositiveWeak
    public static let userBubbleGradientStart = VColor.primaryBase
    public static let userBubbleGradientEnd = VColor.systemPositiveWeak
}
