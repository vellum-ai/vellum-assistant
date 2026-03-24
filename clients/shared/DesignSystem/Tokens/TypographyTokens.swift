import SwiftUI
#if os(macOS)
import AppKit
#elseif os(iOS)
import UIKit
#endif

/// Font presets for the app. Always use these instead of raw Font.system() calls.
///
/// **DM Sans** — geometric sans-serif for headings, body, and UI text.
///
/// Token names follow the Figma type system: Category/Size-Weight.
/// See: Figma → New App → Type (node 2193-4447)
public enum VFont {

    // MARK: - Compact-width scaling (iPhone)

    /// Scale factor applied to heading-sized fonts on iOS to avoid oversized text on iPhone.
    private static let compactScale: CGFloat = 0.85

    /// Returns a scaled size on iOS for fonts >= 18pt; smaller sizes pass through unchanged.
    /// On macOS the base size is always returned unmodified.
    private static func adaptiveSize(_ base: CGFloat) -> CGFloat {
        #if os(iOS)
        guard UIDevice.current.userInterfaceIdiom == .phone else { return base }
        return base >= 18 ? round(base * compactScale) : base
        #else
        return base
        #endif
    }

    // MARK: - Title (Figma)

    public static let titleLarge  = Font.custom("DMSans-Medium", size: adaptiveSize(24))
    public static let titleMedium = Font.custom("DMSans-Medium", size: adaptiveSize(20))
    public static let titleSmall  = Font.custom("DMSans-SemiBold", size: adaptiveSize(18))

    // MARK: - Body (Figma)

    public static let bodyLargeLighter    = Font.custom("DMSans-Regular", size: 16)
    public static let bodyLargeDefault    = Font.custom("DMSans-Medium", size: 16)
    public static let bodyLargeEmphasised = Font.custom("DMSans-SemiBold", size: 16)
    public static let bodyMediumLighter    = Font.custom("DMSans-Regular", size: 14)
    public static let bodyMediumDefault    = Font.custom("DMSans-Medium", size: 14)
    public static let bodyMediumEmphasised = Font.custom("DMSans-SemiBold", size: 14)
    public static let bodySmallDefault    = Font.custom("DMSans-Medium", size: 12)
    public static let bodySmallEmphasised = Font.custom("DMSans-SemiBold", size: 12)

    // MARK: - Label (Figma)

    public static let labelDefault = Font.custom("DMSans-Medium", size: 11)
    public static let labelSmall   = Font.custom("DMSans-Medium", size: 10)

    // MARK: - Chat (Figma — 16pt Medium with 24px line height, applied via .lineSpacing)

    public static let chat = Font.custom("DMSans-Medium", size: 16)

    // MARK: - Specialized

    public static let cardEmoji       = Font.system(size: 32)
    public static let onboardingEmoji = Font.system(size: adaptiveSize(80))

    // MARK: - NSFont (AppKit — for NSTextView and TextKit 1)

    #if os(macOS)
    public static let nsMono: NSFont = {
        let base = NSFont(name: "DMMono-Regular", size: 13)
            ?? NSFont.monospacedSystemFont(ofSize: 13, weight: .regular)
        let descriptor = base.fontDescriptor.addingAttributes([
            .featureSettings: [[
                NSFontDescriptor.FeatureKey.typeIdentifier: kStylisticAlternativesType,
                NSFontDescriptor.FeatureKey.selectorIdentifier: kStylisticAltFiveOnSelector,
            ]]
        ])
        return NSFont(descriptor: descriptor, size: 13) ?? base
    }()

    public static let nsMonoBold: NSFont = {
        NSFontManager.shared.convert(nsMono, toHaveTrait: .boldFontMask)
    }()

    public static let nsMonoItalic: NSFont = {
        NSFontManager.shared.convert(nsMono, toHaveTrait: .italicFontMask)
    }()
    #endif
}
