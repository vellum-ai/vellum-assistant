import SwiftUI
#if os(macOS)
import AppKit
#elseif os(iOS)
import UIKit
#endif

/// Font presets for the app. Always use these instead of raw Font.system() calls.
///
/// **Silkscreen** — pixelated bitmap font for headings and display text.
/// **DM Mono** — monospaced font for body/UI text.
public enum VFont {

    /// DM Mono's default "f" has an exaggerated italic-style hook.
    /// Stylistic Set 5 (ss05) provides a conventional "f" glyph.
    private static func dmMono(_ name: String, size: CGFloat) -> Font {
        #if os(macOS)
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
        #elseif os(iOS)
        guard let uiFont = UIFont(name: name, size: size) else {
            return Font.custom(name, size: size)
        }
        // iOS uses different key names: featureIdentifier = type, typeIdentifier = selector
        let descriptor = uiFont.fontDescriptor.addingAttributes([
            .featureSettings: [[
                UIFontDescriptor.FeatureKey.featureIdentifier: kStylisticAlternativesType,
                UIFontDescriptor.FeatureKey.typeIdentifier: kStylisticAltFiveOnSelector,
            ]]
        ])
        return Font(UIFont(descriptor: descriptor, size: size))
        #else
        // Fallback for unsupported platforms (visionOS, tvOS, watchOS)
        return Font.custom(name, size: size)
        #endif
    }
    // MARK: - Onboarding (Silkscreen pixel font)

    public static let onboardingTitle = Font.custom("Silkscreen-Regular", size: 28)
    public static let onboardingSubtitle = Font.custom("Silkscreen-Regular", size: 15)

    // MARK: - Headings (Silkscreen)
    // TODO: Clean up typography once we solidify the design system - we dont seem to use Bold
    public static let largeTitle = Font.custom("Silkscreen-Bold", size: 26)
    public static let title      = Font.custom("Silkscreen-Bold", size: 22)
    public static let headline   = Font.custom("Silkscreen-Bold", size: 13)

    // MARK: - Body / UI (DM Mono)

    public static let body       = dmMono("DMMono-Regular", size: 13)
    public static let bodyMedium = dmMono("DMMono-Medium", size: 13)
    public static let bodyBold   = dmMono("DMMono-Medium", size: 13)
    public static let caption    = dmMono("DMMono-Regular", size: 11)
    public static let captionMedium = dmMono("DMMono-Medium", size: 11)
    public static let small      = dmMono("DMMono-Regular", size: 10)

    // MARK: - Specialized

    public static let cardTitle  = dmMono("DMMono-Medium", size: 17)
    public static let cardEmoji  = Font.system(size: 32)
    public static let mono       = dmMono("DMMono-Regular", size: 13)
    public static let monoSmall  = dmMono("DMMono-Regular", size: 11)

    /// All-caps pixel display font (used for panel headers like "AGENT", "GENERATED CONTENT")
    public static let display    = Font.custom("Silkscreen-Bold", size: 18)
    public static let panelTitle   = Font.custom("Silkscreen-Regular", size: 24)
    public static let sectionTitle   = Font.custom("Silkscreen-Regular", size: 18)

    /// Small Silkscreen label (used for thread tab names)
    public static let tabLabel   = Font.custom("Silkscreen-Regular", size: 11)
}
