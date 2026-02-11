import SwiftUI

/// Font presets for the app. Always use these instead of raw Font.system() calls.
enum VFont {
    // MARK: - Onboarding (Silkscreen pixel font)

    static let onboardingTitle = Font.custom("Silkscreen-Regular", size: 28)
    static let onboardingSubtitle = Font.custom("Silkscreen-Regular", size: 15)

    // MARK: - Standard Scale

    static let largeTitle = Font.system(size: 24, weight: .bold)
    static let title      = Font.system(size: 18, weight: .semibold)
    static let headline   = Font.system(size: 14, weight: .semibold)
    static let body       = Font.system(size: 13)
    static let bodyMedium = Font.system(size: 13, weight: .medium)
    static let caption    = Font.system(size: 11)
    static let captionMedium = Font.system(size: 11, weight: .medium)
    static let small      = Font.system(size: 10)

    // MARK: - Specialized

    static let cardTitle  = Font.system(size: 17, weight: .semibold)
    static let cardEmoji  = Font.system(size: 32)
    static let mono       = Font.system(size: 13, design: .monospaced)
    static let monoSmall  = Font.system(size: 11, design: .monospaced)
    static let bodyBold   = Font.system(size: 13, weight: .semibold)

    /// All-caps monospaced display font (used for panel headers like "AGENT", "GENERATED CONTENT")
    static let display    = Font.system(size: 18, weight: .black, design: .monospaced)
}
