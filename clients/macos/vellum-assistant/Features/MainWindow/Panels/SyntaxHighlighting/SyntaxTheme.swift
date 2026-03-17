import SwiftUI
#if os(macOS)
import AppKit
#endif
import VellumAssistantShared

/// Maps syntax token types to SwiftUI colors and builds syntax-highlighted `AttributedString` values.
struct SyntaxTheme {

    // MARK: - Token Color

    /// Returns the SwiftUI `Color` for the given syntax token type.
    static func color(for tokenType: SyntaxTokenType) -> Color {
        switch tokenType {
        case .keyword: return VColor.syntaxKeyword
        case .string: return VColor.syntaxString
        case .comment: return VColor.syntaxComment
        case .number: return VColor.syntaxNumber
        case .type: return VColor.syntaxType
        case .property: return VColor.syntaxProperty
        case .boolean, .null: return VColor.syntaxNumber
        case .codeSpan: return VColor.syntaxString
        case .link: return VColor.syntaxLink
        case .heading, .bold, .italic, .plain: return VColor.contentDefault
        }
    }

    // MARK: - Highlighted AttributedString

    /// Tokenizes `text` for `language` and returns an `AttributedString` with
    /// syntax-colored foreground colors and appropriate font variants.
    static func highlight(_ text: String, language: SyntaxLanguage) -> AttributedString {
        let baseFont = VFont.mono

        var attributedString = AttributedString(text)
        attributedString.foregroundColor = VColor.contentDefault
        attributedString.font = baseFont

        guard language != .plain else {
            return attributedString
        }

        let tokens = SyntaxTokenizer.tokenize(text, language: language)

        for token in tokens {
            guard let stringRange = Range(token.range, in: text) else { continue }

            guard let lowerBound = AttributedString.Index(stringRange.lowerBound, within: attributedString),
                  let upperBound = AttributedString.Index(stringRange.upperBound, within: attributedString) else {
                continue
            }

            let attrRange = lowerBound..<upperBound

            attributedString[attrRange].foregroundColor = color(for: token.type)

            switch token.type {
            case .heading, .bold:
                attributedString[attrRange].font = VFont.mono.bold()
            case .italic:
                attributedString[attrRange].font = VFont.mono.italic()
            default:
                break
            }
        }

        return attributedString
    }

    // MARK: - AppKit Bridging

    #if os(macOS)
    /// Returns the `NSColor` for the given syntax token type (for NSTextStorage use).
    static func nsColor(for tokenType: SyntaxTokenType) -> NSColor {
        NSColor(color(for: tokenType))
    }

    /// The monospaced `NSFont` matching `VFont.mono` for NSTextView use.
    static var nsMonoFont: NSFont {
        let baseName = "DMMono-Regular"
        let size: CGFloat = 13
        guard let base = NSFont(name: baseName, size: size) else {
            return NSFont.monospacedSystemFont(ofSize: size, weight: .regular)
        }
        // Apply ss05 stylistic set (conventional "f" glyph), same as VFont.dmMono()
        let descriptor = base.fontDescriptor.addingAttributes([
            .featureSettings: [[
                NSFontDescriptor.FeatureKey.typeIdentifier: kStylisticAlternativesType,
                NSFontDescriptor.FeatureKey.selectorIdentifier: kStylisticAltFiveOnSelector,
            ]]
        ])
        return NSFont(descriptor: descriptor, size: size) ?? base
    }

    /// Applies syntax highlighting to an `NSMutableAttributedString` in-place.
    /// Sets the base font and foreground color, then overlays token colors.
    static func applyHighlighting(to storage: NSMutableAttributedString, language: SyntaxLanguage) {
        let fullRange = NSRange(location: 0, length: storage.length)
        let text = storage.string

        // Set base attributes
        storage.addAttribute(.font, value: nsMonoFont, range: fullRange)
        storage.addAttribute(.foregroundColor, value: NSColor(VColor.contentDefault), range: fullRange)

        guard language != .plain else { return }

        let tokens = SyntaxTokenizer.tokenize(text, language: language)
        for token in tokens {
            guard token.range.location + token.range.length <= storage.length else { continue }
            storage.addAttribute(.foregroundColor, value: nsColor(for: token.type), range: token.range)

            switch token.type {
            case .heading, .bold:
                if let boldFont = NSFontManager.shared.convert(nsMonoFont, toHaveTrait: .boldFontMask) as NSFont? {
                    storage.addAttribute(.font, value: boldFont, range: token.range)
                }
            case .italic:
                if let italicFont = NSFontManager.shared.convert(nsMonoFont, toHaveTrait: .italicFontMask) as NSFont? {
                    storage.addAttribute(.font, value: italicFont, range: token.range)
                }
            default:
                break
            }
        }
    }
    #endif
}
