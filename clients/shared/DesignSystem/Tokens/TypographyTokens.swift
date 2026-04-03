import SwiftUI
#if os(macOS)
import AppKit
#elseif os(iOS)
import UIKit
#endif

/// Font presets for the app. Always use these instead of raw Font.system() calls.
///
/// **Inter** — clean sans-serif for headings, body, and UI text.
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

    /// Creates an Inter font at the given CSS weight (400/500/600) and size.
    ///
    /// Loads the bundled Inter variable font by PostScript name, then creates
    /// a variation copy with the requested `wght` axis value via CTFont.
    private static func inter(weight: Int, size: CGFloat) -> Font {
        let baseName = "InterVariable" as CFString
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
        return Font.custom("Inter-Regular", fixedSize: size)
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
    public static let brandMini   = instrumentSerif(weight: 400, size: adaptiveSize(16))

    // MARK: - Display

    public static let displayLarge = inter(weight: 300, size: adaptiveSize(32))

    // MARK: - Title (Figma — Inter Medium)

    public static let titleLarge  = inter(weight: 400, size: adaptiveSize(24))
    public static let titleMedium = inter(weight: 400, size: adaptiveSize(20))
    public static let titleSmall  = inter(weight: 400, size: adaptiveSize(16))

    // MARK: - Body (Figma — Inter)

    public static let bodyLargeLighter    = inter(weight: 300, size: 16)
    public static let bodyLargeDefault    = inter(weight: 400, size: 16)
    public static let bodyMediumLighter   = inter(weight: 300, size: 14)
    public static let bodyMediumDefault   = inter(weight: 400, size: 14)
    public static let bodySmallDefault    = inter(weight: 400, size: 12)
    public static let bodySmallEmphasised = inter(weight: 500, size: 12)


    // MARK: - Label (Figma — Inter Medium)

    public static let labelDefault = inter(weight: 400, size: 11)
    public static let labelSmall   = inter(weight: 400, size: 10)

    // MARK: - Menu

    /// 13pt Inter — compact menu item text matching sidebar conversation rows.
    public static let menuCompact = inter(weight: 300, size: 13)

    // MARK: - Chat (Figma — Inter Regular, 16pt, 24px line height)

    public static let chat = inter(weight: 300, size: 16)

    // MARK: - Specialized

    public static let cardEmoji       = Font.system(size: 32)
    public static let onboardingEmoji = Font.system(size: adaptiveSize(80))

    // MARK: - NSFont (AppKit — for NSTextView and TextKit 1)

    #if os(macOS)
    /// Creates an Inter `NSFont` at the given CSS weight and size via CTFont variation axis.
    public static func nsInter(weight: Int, size: CGFloat) -> NSFont {
        let baseName = "InterVariable" as CFString
        let baseFont = CTFontCreateWithName(baseName, size, nil)
        let variations: [CFNumber: CFNumber] = [
            wghtTag as CFNumber: weight as CFNumber,
        ]
        return CTFontCreateCopyWithAttributes(
            baseFont, size, nil,
            CTFontDescriptorCreateWithAttributes([
                kCTFontVariationAttribute: variations,
            ] as CFDictionary)
        ) as NSFont
    }

    /// NSFont equivalent of `VFont.chat`.
    public static let nsChat: NSFont = nsInter(weight: 300, size: 16)

    /// NSFont equivalent of `VFont.bodyMediumDefault`.
    public static let nsBodyMediumDefault: NSFont = nsInter(weight: 400, size: 14)

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

    // MARK: - Prewarm

    /// Eagerly accesses every static font token, forcing CoreText to resolve and cache them.
    ///
    /// Safe to call from any thread — uses only CoreText (thread-safe).
    /// Called by `FontWarmupCoordinator` during off-main warmup.
    ///
    /// **Note:** `nsMonoBold` and `nsMonoItalic` are excluded because they use
    /// `NSFontManager.shared` which must be accessed on the main thread.
    /// Use `prewarmNSFontManagerTokens()` on MainActor for those.
    public static func prewarmForAppLaunch() {
        // SwiftUI Font tokens
        _ = brandMedium
        _ = brandSmall
        _ = brandMini
        _ = displayLarge
        _ = titleLarge
        _ = titleMedium
        _ = titleSmall
        _ = bodyLargeLighter
        _ = bodyLargeDefault
        _ = bodyMediumLighter
        _ = bodyMediumDefault
        _ = bodySmallDefault
        _ = bodySmallEmphasised
        _ = labelDefault
        _ = labelSmall
        _ = menuCompact
        _ = chat

        // NSFont tokens (macOS only)
        #if os(macOS)
        _ = nsChat
        _ = nsBodyMediumDefault
        _ = nsMono
        // NOTE: nsMonoBold and nsMonoItalic are intentionally excluded here.
        // They use NSFontManager.shared.convert() which requires the main thread.
        // See prewarmNSFontManagerTokens() instead.
        #endif
    }

    #if os(macOS)
    /// Prewarms font tokens that depend on `NSFontManager.shared`.
    ///
    /// **Must be called on the main thread** — `NSFontManager` is an AppKit class
    /// without documented thread-safety guarantees.
    /// Called by `FontWarmupCoordinator` on `MainActor` before marking ready.
    @MainActor
    public static func prewarmNSFontManagerTokens() {
        _ = nsMonoBold
        _ = nsMonoItalic
    }
    #endif
}
