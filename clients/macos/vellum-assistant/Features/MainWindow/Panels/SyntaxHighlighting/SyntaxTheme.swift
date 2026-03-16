import AppKit
import VellumAssistantShared

/// Maps syntax token types to appearance-aware styled text attributes.
struct SyntaxTheme {

    // MARK: - Adaptive Color Helper

    /// Creates an `NSColor` that resolves to `light` or `dark` based on the
    /// current window appearance (System / Light / Dark).
    private static func adaptiveNSColor(
        light: NSColor,
        dark: NSColor
    ) -> NSColor {
        NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? dark : light
        }
    }

    // MARK: - Token Colors

    /// Base text color for unhighlighted content.
    static let baseTextColor = adaptiveNSColor(
        light: NSColor(red: 0.20, green: 0.20, blue: 0.20, alpha: 1.0),
        dark: NSColor(red: 0.85, green: 0.85, blue: 0.85, alpha: 1.0)
    )

    // Syntax token colors derived from the shared VColor.syntax* adaptive tokens.
    private static let keywordColor = NSColor(VColor.syntaxKeyword)
    private static let stringColor = NSColor(VColor.syntaxString)
    private static let commentColor = NSColor(VColor.syntaxComment)
    private static let numberColor = NSColor(VColor.syntaxNumber)
    private static let typeColor = NSColor(VColor.syntaxType)
    private static let propertyColor = NSColor(VColor.syntaxProperty)
    private static let linkColor = NSColor(VColor.syntaxLink)

    // MARK: - Attribute Resolution

    /// Returns attributed string attributes for the given token type.
    ///
    /// Colors adapt to the current system appearance (light or dark). Font
    /// traits (bold, italic) are derived from the provided base font.
    static func attributes(for tokenType: SyntaxTokenType, baseFont: NSFont) -> [NSAttributedString.Key: Any] {
        let color: NSColor
        var font = baseFont

        switch tokenType {
        case .keyword:
            color = keywordColor

        case .string:
            color = stringColor

        case .comment:
            color = commentColor

        case .number:
            color = numberColor

        case .type:
            color = typeColor

        case .property:
            color = propertyColor

        case .boolean, .null:
            color = numberColor

        case .heading:
            color = baseTextColor
            font = NSFontManager.shared.convert(baseFont, toHaveTrait: .boldFontMask)

        case .bold:
            color = baseTextColor
            font = NSFontManager.shared.convert(baseFont, toHaveTrait: .boldFontMask)

        case .italic:
            color = baseTextColor
            font = NSFontManager.shared.convert(baseFont, toHaveTrait: .italicFontMask)

        case .codeSpan:
            color = stringColor

        case .link:
            color = linkColor

        case .plain:
            color = baseTextColor
        }

        return [
            .foregroundColor: color,
            .font: font,
        ]
    }

    // MARK: - Resolved Attributes (for SwiftUI-hosted NSTextView)

    /// Dynamic NSColors stored in NSAttributedString foreground color attributes
    /// may not resolve correctly inside an NSTextView hosted in SwiftUI via
    /// NSViewRepresentable. These methods pre-resolve colors to static sRGB
    /// values based on the text view's effective appearance.

    /// Returns the base text color pre-resolved for the given appearance.
    static func resolvedBaseTextColor(isDark: Bool) -> NSColor {
        isDark
            ? NSColor(srgbRed: 0.85, green: 0.85, blue: 0.85, alpha: 1.0)
            : NSColor(srgbRed: 0.20, green: 0.20, blue: 0.20, alpha: 1.0)
    }

    /// Returns attributed string attributes with pre-resolved (non-dynamic) colors.
    static func resolvedAttributes(for tokenType: SyntaxTokenType, baseFont: NSFont, isDark: Bool) -> [NSAttributedString.Key: Any] {
        var attrs = attributes(for: tokenType, baseFont: baseFont)
        if let color = attrs[.foregroundColor] as? NSColor {
            attrs[.foregroundColor] = resolveColor(color, isDark: isDark)
        }
        return attrs
    }

    /// Resolves a potentially-dynamic NSColor into a static sRGB color.
    private static func resolveColor(_ dynamicColor: NSColor, isDark: Bool) -> NSColor {
        let appearance = NSAppearance(named: isDark ? .darkAqua : .aqua)!
        let saved = NSAppearance.current
        NSAppearance.current = appearance
        defer { NSAppearance.current = saved }
        guard let resolved = dynamicColor.usingColorSpace(.sRGB) else { return dynamicColor }
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        resolved.getRed(&r, green: &g, blue: &b, alpha: &a)
        return NSColor(srgbRed: r, green: g, blue: b, alpha: a)
    }
}
