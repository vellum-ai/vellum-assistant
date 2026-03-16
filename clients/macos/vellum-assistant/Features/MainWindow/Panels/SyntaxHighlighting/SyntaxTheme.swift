import AppKit

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

    private static let keywordColor = adaptiveNSColor(
        light: NSColor(red: 0.33, green: 0.25, blue: 0.80, alpha: 1.0),
        dark: NSColor(red: 0.55, green: 0.65, blue: 0.96, alpha: 1.0)
    )

    private static let stringColor = adaptiveNSColor(
        light: NSColor(red: 0.72, green: 0.19, blue: 0.10, alpha: 1.0),
        dark: NSColor(red: 0.87, green: 0.55, blue: 0.47, alpha: 1.0)
    )

    private static let commentColor = adaptiveNSColor(
        light: NSColor(red: 0.42, green: 0.47, blue: 0.42, alpha: 1.0),
        dark: NSColor(red: 0.55, green: 0.60, blue: 0.55, alpha: 1.0)
    )

    private static let numberColor = adaptiveNSColor(
        light: NSColor(red: 0.55, green: 0.28, blue: 0.73, alpha: 1.0),
        dark: NSColor(red: 0.73, green: 0.56, blue: 0.87, alpha: 1.0)
    )

    private static let typeColor = adaptiveNSColor(
        light: NSColor(red: 0.15, green: 0.55, blue: 0.52, alpha: 1.0),
        dark: NSColor(red: 0.45, green: 0.78, blue: 0.74, alpha: 1.0)
    )

    private static let propertyColor = adaptiveNSColor(
        light: NSColor(red: 0.35, green: 0.50, blue: 0.68, alpha: 1.0),
        dark: NSColor(red: 0.68, green: 0.78, blue: 0.88, alpha: 1.0)
    )

    private static let linkColor = adaptiveNSColor(
        light: NSColor(red: 0.12, green: 0.52, blue: 0.32, alpha: 1.0),
        dark: NSColor(red: 0.30, green: 0.75, blue: 0.55, alpha: 1.0)
    )

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
}
