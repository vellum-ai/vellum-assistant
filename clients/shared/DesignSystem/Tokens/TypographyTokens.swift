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

    /// The `wght` OpenType variation axis tag (0x77676874).
    private static let wghtTag: Int = 0x77676874

    /// Creates a DM Sans font at the given CSS weight (400/500/600) and size.
    ///
    /// Loads the base font by PostScript name (which CTFontManagerRegisterFontsForURL
    /// makes available at process scope), then creates a variation copy with the
    /// requested `wght` axis value via CTFont.
    private static func dmSans(weight: Int, size: CGFloat) -> Font {
        // Use the PostScript name that matches the registered file's default instance.
        // Any of the three registered files works — we override the weight axis below.
        let baseName = "DMSans-Regular" as CFString
        let baseFont = CTFontCreateWithName(baseName, size, nil)
        let variations: [CFNumber: CFNumber] = [
            wghtTag as CFNumber: weight as CFNumber,
        ]
        let variantFont = CTFontCreateCopyWithAttributes(
            baseFont, size, nil,
            CTFontDescriptorCreateWithAttributes([
                kCTFontVariationAttribute: variations,
            ] as CFDictionary)
        )
        #if os(macOS)
        let nsFont = variantFont as NSFont
        return Font(nsFont)
        #elseif os(iOS)
        let uiFont = variantFont as! UIFont
        return Font(uiFont)
        #else
        return Font.custom("DMSans-Regular", fixedSize: size)
        #endif
    }

    /// Creates an Instrument Serif font at the given CSS weight and size.
    private static func instrumentSerif(weight: Int, size: CGFloat) -> Font {
        let baseName = "InstrumentSerif-Regular" as CFString
        let baseFont = CTFontCreateWithName(baseName, size, nil)
        let variations: [CFNumber: CFNumber] = [
            wghtTag as CFNumber: weight as CFNumber,
        ]
        let variantFont = CTFontCreateCopyWithAttributes(
            baseFont, size, nil,
            CTFontDescriptorCreateWithAttributes([
                kCTFontVariationAttribute: variations,
            ] as CFDictionary)
        )
        #if os(macOS)
        let nsFont = variantFont as NSFont
        return Font(nsFont)
        #elseif os(iOS)
        let uiFont = variantFont as! UIFont
        return Font(uiFont)
        #else
        return Font.custom("InstrumentSerif-Regular", fixedSize: size)
        #endif
    }

    // MARK: - Brand (Figma — Instrument Serif)

    public static let brandMedium = instrumentSerif(weight: 400, size: adaptiveSize(32))
    public static let brandSmall  = instrumentSerif(weight: 400, size: adaptiveSize(22))

    // MARK: - Display

    public static let displayLarge = dmSans(weight: 400, size: adaptiveSize(32))

    // MARK: - Title (Figma)

    public static let titleLarge  = dmSans(weight: 400, size: adaptiveSize(24))
    public static let titleMedium = dmSans(weight: 400, size: adaptiveSize(20))
    public static let titleSmall  = dmSans(weight: 500, size: adaptiveSize(16))

    // MARK: - Body (Figma)

    public static let bodyLargeLighter    = dmSans(weight: 300, size: 16)
    public static let bodyLargeDefault    = dmSans(weight: 400, size: 16)
    public static let bodyLargeEmphasised = dmSans(weight: 500, size: 16)
    public static let bodyMediumLighter    = dmSans(weight: 300, size: 14)
    public static let bodyMediumDefault    = dmSans(weight: 400, size: 14)
    public static let bodyMediumEmphasised = dmSans(weight: 500, size: 14)
    public static let bodySmallDefault    = dmSans(weight: 400, size: 12)
    public static let bodySmallEmphasised = dmSans(weight: 500, size: 12)

    // MARK: - Label (Figma)

    public static let labelDefault = dmSans(weight: 400, size: 11)
    public static let labelSmall   = dmSans(weight: 400, size: 10)

    // MARK: - Menu

    /// 13pt DM Sans — compact menu item text matching sidebar conversation rows.
    public static let menuCompact = dmSans(weight: 400, size: 13)

    // MARK: - Chat (Figma — 16pt Medium with 24px line height, applied via .lineSpacing)

    public static let chat = dmSans(weight: 400, size: 16)

    // MARK: - Specialized

    public static let cardEmoji       = Font.system(size: 32)
    public static let onboardingEmoji = Font.system(size: adaptiveSize(80))

    // MARK: - NSFont (AppKit — for NSTextView and TextKit 1)

    #if os(macOS)
    /// Creates a DM Sans `NSFont` at the given CSS weight and size.
    /// AppKit equivalent of the SwiftUI `dmSans(weight:size:)` helper.
    private static func nsDmSans(weight: Int, size: CGFloat) -> NSFont {
        let baseName = "DMSans-Regular" as CFString
        let baseFont = CTFontCreateWithName(baseName, size, nil)
        let variations: [CFNumber: CFNumber] = [
            wghtTag as CFNumber: weight as CFNumber,
        ]
        let variantFont = CTFontCreateCopyWithAttributes(
            baseFont, size, nil,
            CTFontDescriptorCreateWithAttributes([
                kCTFontVariationAttribute: variations,
            ] as CFDictionary)
        )
        return variantFont as NSFont
    }

    /// DM Sans 400 at 16pt — NSFont equivalent of `VFont.chat`.
    public static let nsChat: NSFont = nsDmSans(weight: 400, size: 16)

    /// DM Sans 400 at 14pt — NSFont equivalent of `VFont.bodyMediumDefault`.
    public static let nsBodyMediumDefault: NSFont = nsDmSans(weight: 400, size: 14)

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
