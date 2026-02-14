import AppKit
import SwiftUI

/// Font presets for the app. Always use these instead of raw Font.system() calls.
///
/// **Silkscreen** — pixelated bitmap font for headings and display text.
/// **DM Mono** — monospaced font for body/UI text.
enum VFont {

    /// DM Mono's default "f" has an exaggerated italic-style hook.
    /// Stylistic Set 5 (ss05) provides a conventional "f" glyph.
    private static func dmMono(_ name: String, size: CGFloat) -> Font {
        guard let nsFont = NSFont(name: name, size: size) else {
            return Font.custom(name, size: size)
        }
        let descriptor = nsFont.fontDescriptor.addingAttributes([
            .featureSettings: [[
                NSFontDescriptor.FeatureKey.typeIdentifier: kStylisticAlternativesType,
                NSFontDescriptor.FeatureKey.selectorIdentifier: kStylisticAltFiveOnSelector,
            ]]
        ])
        return Font(NSFont(descriptor: descriptor, size: size) ?? nsFont)
    }
    // MARK: - Onboarding (Silkscreen pixel font)

    static let onboardingTitle = Font.custom("Silkscreen-Regular", size: 28)
    static let onboardingSubtitle = Font.custom("Silkscreen-Regular", size: 15)

    // MARK: - Headings (Silkscreen)
    // TODO: Clean up typography once we solidify the design system - we dont seem to use Bold
    static let largeTitle = Font.custom("Silkscreen-Bold", size: 26)
    static let title      = Font.custom("Silkscreen-Bold", size: 22)
    static let headline   = Font.custom("Silkscreen-Bold", size: 13)

    // MARK: - Body / UI (DM Mono)

    static let body       = dmMono("DMMono-Regular", size: 13)
    static let bodyMedium = dmMono("DMMono-Medium", size: 13)
    static let bodyBold   = dmMono("DMMono-Medium", size: 13)
    static let caption    = dmMono("DMMono-Regular", size: 11)
    static let captionMedium = dmMono("DMMono-Medium", size: 11)
    static let small      = dmMono("DMMono-Regular", size: 10)

    // MARK: - Specialized

    static let cardTitle  = dmMono("DMMono-Medium", size: 17)
    static let cardEmoji  = Font.system(size: 32)
    static let mono       = dmMono("DMMono-Regular", size: 13)
    static let monoSmall  = dmMono("DMMono-Regular", size: 11)

    /// All-caps pixel display font (used for panel headers like "AGENT", "GENERATED CONTENT")
    static let display    = Font.custom("Silkscreen-Bold", size: 18)
    static let panelTitle   = Font.custom("Silkscreen-Regular", size: 24)
    static let sectionTitle   = Font.custom("Silkscreen-Regular", size: 18)

    /// Small Silkscreen label (used for thread tab names)
    static let tabLabel   = Font.custom("Silkscreen-Regular", size: 11)
}
