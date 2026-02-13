import SwiftUI

/// Font presets for the app. Always use these instead of raw Font.system() calls.
///
/// **Silkscreen** — pixelated bitmap font for headings and display text.
/// **DM Mono** — monospaced font for body/UI text.
enum VFont {
    // MARK: - Onboarding (Silkscreen pixel font)

    static let onboardingTitle = Font.custom("Silkscreen-Regular", size: 28)
    static let onboardingSubtitle = Font.custom("Silkscreen-Regular", size: 15)

    // MARK: - Headings (Silkscreen)

    static let largeTitle = Font.custom("Silkscreen-Bold", size: 26)
    static let title      = Font.custom("Silkscreen-Bold", size: 22)
    static let headline   = Font.custom("Silkscreen-Bold", size: 13)

    // MARK: - Body / UI (DM Mono)

    static let body       = Font.custom("DMMono-Regular", size: 13)
    static let bodyMedium = Font.custom("DMMono-Medium", size: 13)
    static let bodyBold   = Font.custom("DMMono-Medium", size: 13)
    static let caption    = Font.custom("DMMono-Regular", size: 11)
    static let captionMedium = Font.custom("DMMono-Medium", size: 11)
    static let small      = Font.custom("DMMono-Regular", size: 10)

    // MARK: - Specialized

    static let cardTitle  = Font.custom("DMMono-Medium", size: 17)
    static let cardEmoji  = Font.system(size: 32)
    static let mono       = Font.custom("DMMono-Regular", size: 13)
    static let monoSmall  = Font.custom("DMMono-Regular", size: 11)

    /// All-caps pixel display font (used for panel headers like "AGENT", "GENERATED CONTENT")
    static let display    = Font.custom("Silkscreen-Bold", size: 18)

    /// Small Silkscreen label (used for thread tab names)
    static let tabLabel   = Font.custom("Silkscreen-Regular", size: 11)
}
