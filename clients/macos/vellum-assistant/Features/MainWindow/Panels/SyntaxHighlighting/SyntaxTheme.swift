import AppKit

/// Maps syntax token types to styled text attributes for dark backgrounds.
struct SyntaxTheme {

    /// Base text color for unhighlighted content on dark backgrounds.
    static let baseTextColor = NSColor(red: 0.85, green: 0.85, blue: 0.85, alpha: 1.0)

    /// Returns attributed string attributes for the given token type.
    ///
    /// Colors are chosen for readability against dark backgrounds. Font traits
    /// (bold, italic) are derived from the provided base font.
    static func attributes(for tokenType: SyntaxTokenType, baseFont: NSFont) -> [NSAttributedString.Key: Any] {
        let color: NSColor
        var font = baseFont

        switch tokenType {
        case .keyword:
            color = NSColor(red: 0.55, green: 0.65, blue: 0.96, alpha: 1.0)

        case .string:
            color = NSColor(red: 0.87, green: 0.55, blue: 0.47, alpha: 1.0)

        case .comment:
            color = NSColor(red: 0.55, green: 0.60, blue: 0.55, alpha: 1.0)

        case .number:
            color = NSColor(red: 0.73, green: 0.56, blue: 0.87, alpha: 1.0)

        case .type:
            color = NSColor(red: 0.45, green: 0.78, blue: 0.74, alpha: 1.0)

        case .property:
            color = NSColor(red: 0.68, green: 0.78, blue: 0.88, alpha: 1.0)

        case .boolean, .null:
            color = NSColor(red: 0.73, green: 0.56, blue: 0.87, alpha: 1.0)

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
            color = NSColor(red: 0.87, green: 0.55, blue: 0.47, alpha: 1.0)

        case .link:
            color = NSColor(red: 0.30, green: 0.75, blue: 0.55, alpha: 1.0)

        case .plain:
            color = baseTextColor
        }

        return [
            .foregroundColor: color,
            .font: font,
        ]
    }
}
