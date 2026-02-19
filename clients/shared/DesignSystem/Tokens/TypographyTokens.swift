import SwiftUI
#if os(macOS)
import AppKit
#elseif os(iOS)
import UIKit
#endif

/// Font presets for the app. Always use these instead of raw Font.system() calls.
///
/// **Inter** — humanist sans-serif for headings, body, and UI text.
/// **DM Mono** — monospaced font for code and debug views.
/// **Silkscreen** — pixelated bitmap font, used sparingly for buttons.
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
    // MARK: - Onboarding

    public static let onboardingTitle = Font.custom("Fraunces", size: 28).weight(.semibold)
    public static let onboardingSubtitle = Font.system(size: 15)

    // MARK: - Headings (Inter)

    public static let largeTitle = Font.custom("Inter-SemiBold", size: 26)
    public static let title      = Font.custom("Inter-SemiBold", size: 22)
    public static let headline   = Font.custom("Inter-SemiBold", size: 13)

    // MARK: - Body / UI (Inter)

    public static let body       = Font.custom("Inter", size: 13)
    public static let bodyMedium = Font.custom("Inter-Medium", size: 13)
    public static let bodyBold   = Font.custom("Inter-SemiBold", size: 13)
    public static let caption    = Font.custom("Inter", size: 11)
    public static let captionMedium = Font.custom("Inter-Medium", size: 11)
    public static let small      = Font.custom("Inter", size: 10)

    // MARK: - Specialized

    public static let cardTitle  = Font.custom("Inter-Medium", size: 17)
    public static let cardEmoji  = Font.system(size: 32)
    public static let onboardingEmoji = Font.system(size: 80)
    public static let mono       = dmMono("DMMono-Regular", size: 13)
    public static let monoSmall  = dmMono("DMMono-Regular", size: 11)
    public static let monoMedium = dmMono("DMMono-Medium", size: 16)

    /// Display font (used for panel headers like "AGENT", "GENERATED CONTENT")
    public static let display    = Font.custom("Inter-SemiBold", size: 18)
    public static let panelTitle   = Font.custom("Inter-Medium", size: 24)
    public static let sectionTitle   = Font.custom("Inter-Medium", size: 18)

    /// Small label (used for thread tab names)
    public static let tabLabel   = Font.custom("Inter", size: 11)

    // MARK: - Pixel (Silkscreen — use sparingly, e.g. buttons)

    public static let pixel      = Font.custom("Silkscreen-Regular", size: 13)
    public static let pixelSmall = Font.custom("Silkscreen-Regular", size: 11)
}
