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

    /// Creates a DM Sans font at the given weight and size with the `tnum` OpenType
    /// feature enabled (tabular numerals — every digit occupies the same advance width).
    ///
    /// Used for elements where digit columns must align (position pills like "#1"/"#12",
    /// counters, timers). Equivalent to `dmSans(weight:size:)` plus a
    /// `.featureSettings(.init(tag: "tnum", value: 1))` treatment applied at the
    /// CoreText layer so the feature survives the SwiftUI→CT→NS/UIFont bridge.
    private static func dmSansTabular(weight: Int, size: CGFloat) -> Font {
        let baseName = "DMSans-Regular" as CFString
        let baseFont = CTFontCreateWithName(baseName, size, nil)
        let variations: [CFNumber: CFNumber] = [
            wghtTag as CFNumber: weight as CFNumber,
        ]
        // OpenType feature "tnum" = tabular numerals. CoreText's OpenType feature keys
        // expect the tag as a 4-character CFString and the value as a CFNumber (1 = on).
        let openTypeFeatures: [[CFString: Any]] = [[
            kCTFontOpenTypeFeatureTag: "tnum" as CFString,
            kCTFontOpenTypeFeatureValue: 1 as CFNumber,
        ]]
        let descriptor = CTFontDescriptorCreateWithAttributes([
            kCTFontVariationAttribute: variations,
            kCTFontFeatureSettingsAttribute: openTypeFeatures,
        ] as CFDictionary)
        let variantFont = CTFontCreateCopyWithAttributes(baseFont, size, nil, descriptor)
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
    public static let brandMini   = instrumentSerif(weight: 400, size: adaptiveSize(16))

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

    /// DM Sans at label size with tabular numerals (`tnum`) enabled — for position pills,
    /// counters, and other short numeric labels where digits must align in a column.
    public static let numericMono = dmSansTabular(weight: 400, size: 11)

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
    package struct ChatMarkdownFontSet {
        package let regular: NSFont
        package let bold: NSFont
        package let italic: NSFont
        package let boldItalic: NSFont
        package let regularIsResolved: Bool
        package let boldIsResolved: Bool
        package let italicIsResolved: Bool
        package let boldItalicIsResolved: Bool
        package let isResolved: Bool
        package let diagnosticPostScriptNames: [String: String]
    }

    @MainActor
    package final class TypographyRefreshObserver: ObservableObject {
        @Published package fileprivate(set) var generation: Int = 0
    }

    private static let dmSansFamilyName = "DM Sans"
    @MainActor package static var typographyGeneration: Int = 0
    @MainActor package static let typographyObserver = TypographyRefreshObserver()

    #if DEBUG
    package static var _chatMarkdownFontSetOverride: ((CGFloat) -> ChatMarkdownFontSet)?
    #endif

    /// Creates a DM Sans `NSFont` at the given CSS weight and size.
    /// AppKit equivalent of the SwiftUI `dmSans(weight:size:)` helper.
    private static func nsDmSans(weight: Int, size: CGFloat) -> NSFont {
        resolvedDMSansFont(weight: weight, size: size)
    }

    /// DM Sans 400 at 16pt — NSFont equivalent of `VFont.chat`.
    public static let nsChat: NSFont = nsDmSans(weight: 400, size: 16)

    /// DM Sans 400 at 14pt — NSFont equivalent of `VFont.bodyMediumDefault`.
    public static let nsBodyMediumDefault: NSFont = nsDmSans(weight: 400, size: 14)

    /// DM Sans 400 at 12pt — NSFont equivalent of `VFont.bodySmallDefault`.
    public static let nsBodySmallDefault: NSFont = nsDmSans(weight: 400, size: 12)

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
        let base = NSFont(name: "DMMono-Medium", size: 13)
            ?? NSFont.monospacedSystemFont(ofSize: 13, weight: .medium)
        let descriptor = base.fontDescriptor.addingAttributes([
            .featureSettings: [[
                NSFontDescriptor.FeatureKey.typeIdentifier: kStylisticAlternativesType,
                NSFontDescriptor.FeatureKey.selectorIdentifier: kStylisticAltFiveOnSelector,
            ]]
        ])
        return NSFont(descriptor: descriptor, size: 13) ?? base
    }()

    public static let nsMonoItalic: NSFont = {
        // Synthetic italic via horizontal shear. tan(12°) matches the standard
        // oblique angle AppKit applies when no native italic variant exists.
        var transform = CGAffineTransform(a: 1, b: 0, c: CGFloat(tan(12.0 * .pi / 180.0)), d: 1, tx: 0, ty: 0)
        return CTFontCreateCopyWithAttributes(nsMono as CTFont, 13, &transform, nil) as NSFont
    }()

    @MainActor
    package static func bumpTypographyGeneration() {
        typographyGeneration &+= 1
        typographyObserver.generation = typographyGeneration
    }

    package static func resolvedChatMarkdownFontSet(size: CGFloat = 16) -> ChatMarkdownFontSet {
        #if DEBUG
        if let override = _chatMarkdownFontSetOverride {
            return override(size)
        }
        #endif

        // Italic and boldItalic carry NO font-matrix slant — the slant is
        // applied as a separate `.obliqueness` NSAttributedString attribute at
        // emphasis-application time. NSTextView normalizes matrix-transformed
        // fonts away during `setAttributedString` in some cases (observed when
        // SwiftUI-bridged AttributedStrings flow through VSelectableTextView),
        // so the matrix can't be relied on to reach the glyph renderer.
        let regular = resolvedDMSansFont(weight: 400, size: size)
        let bold = resolvedDMSansFont(weight: 700, size: size)
        let italic = resolvedDMSansFont(weight: 400, size: size)
        let boldItalic = resolvedDMSansFont(weight: 700, size: size)

        let diagnosticPostScriptNames = [
            "regular": postScriptName(for: regular),
            "bold": postScriptName(for: bold),
            "italic": postScriptName(for: italic),
            "boldItalic": postScriptName(for: boldItalic),
        ]

        let regularIsResolved = isResolvedDMSans(regular)
        let boldIsResolved = isResolvedDMSans(bold) && hasWeightAxis(bold, expected: 700)
        let italicIsResolved = isResolvedDMSans(italic)
        let boldItalicIsResolved =
            isResolvedDMSans(boldItalic)
            && hasWeightAxis(boldItalic, expected: 700)

        return ChatMarkdownFontSet(
            regular: regular,
            bold: bold,
            italic: italic,
            boldItalic: boldItalic,
            regularIsResolved: regularIsResolved,
            boldIsResolved: boldIsResolved,
            italicIsResolved: italicIsResolved,
            boldItalicIsResolved: boldItalicIsResolved,
            isResolved: regularIsResolved && boldIsResolved && italicIsResolved && boldItalicIsResolved,
            diagnosticPostScriptNames: diagnosticPostScriptNames
        )
    }

    package static func resolvedDMSansFont(weight: Int, size: CGFloat) -> NSFont {
        let baseName = "DMSans-Regular" as CFString
        let baseFont = CTFontCreateWithName(baseName, size, nil)
        let variations: [CFNumber: CFNumber] = [
            wghtTag as CFNumber: weight as CFNumber,
        ]
        let descriptor = CTFontDescriptorCreateWithAttributes([
            kCTFontVariationAttribute: variations,
        ] as CFDictionary)
        return CTFontCreateCopyWithAttributes(baseFont, size, nil, descriptor) as NSFont
    }

    private static func isResolvedDMSans(_ font: NSFont) -> Bool {
        familyName(for: font) == dmSansFamilyName
    }

    private static func familyName(for font: NSFont) -> String {
        CTFontCopyFamilyName(font as CTFont) as String
    }

    private static func postScriptName(for font: NSFont) -> String {
        CTFontCopyPostScriptName(font as CTFont) as String
    }

    private static func hasWeightAxis(_ font: NSFont, expected: Int) -> Bool {
        guard let variations = CTFontCopyVariation(font as CTFont) as? [NSNumber: NSNumber],
              let value = variations[wghtTag as NSNumber] else {
            return false
        }
        return abs(CGFloat(truncating: value) - CGFloat(expected)) < 0.5
    }
    #endif

    // MARK: - Prewarm

    /// Eagerly accesses every static font token, forcing CoreText to resolve and cache them.
    ///
    /// Safe to call from any thread — uses only CoreText (thread-safe).
    /// Called by `FontWarmupCoordinator` during off-main warmup.
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
        _ = bodyLargeEmphasised
        _ = bodyMediumLighter
        _ = bodyMediumDefault
        _ = bodyMediumEmphasised
        _ = bodySmallDefault
        _ = bodySmallEmphasised
        _ = labelDefault
        _ = labelSmall
        _ = numericMono
        _ = menuCompact
        _ = chat

        // NSFont tokens (macOS only — CoreText-only, no AppKit dependency)
        #if os(macOS)
        _ = nsChat
        _ = nsBodyMediumDefault
        _ = nsBodySmallDefault
        _ = nsMono
        _ = nsMonoBold
        _ = nsMonoItalic
        #endif
    }

}
