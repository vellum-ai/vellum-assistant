import AppKit
import SwiftUI
import VellumAssistantShared

/// Maps syntax token types to SwiftUI colors and builds syntax-highlighted `AttributedString` values.
///
/// All public API is `static` and thread-safe. The `highlight` function is
/// `nonisolated` so it can run on any executor (typically a background thread
/// via a child `Task`) without breaking structured concurrency.
struct SyntaxTheme: Sendable {

    // MARK: - Token Color

    /// Returns the SwiftUI `Color` for the given syntax token type.
    ///
    /// `Color` conforms to `Sendable`, and `VColor.*` are static lets on an
    /// enum, so these lookups are safe from any thread.
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

    /// Text size threshold above which syntax highlighting is skipped to avoid
    /// UI freezes from expensive regex tokenization on large files.
    private static let maxHighlightSize = 500 * 1024 // 500 KB

    // Pre-resolved SwiftUI font variants cached as static lets.
    // `Font` is `Sendable`, so these are safe to read from any thread.
    private static let baseFont = VFont.mono
    private static let boldFont = VFont.mono.bold()
    private static let italicFont = VFont.mono.italic()
    private static let defaultForeground = VColor.contentDefault

    // Pre-resolved NSFont for AppKit-based text views (NSTextView).
    // DMMono-Regular 13pt with ss05 stylistic set (conventional "f").
    static let nsFont: NSFont = {
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

    static let nsBoldFont: NSFont = {
        NSFontManager.shared.convert(nsFont, toHaveTrait: .boldFontMask)
    }()

    static let nsItalicFont: NSFont = {
        NSFontManager.shared.convert(nsFont, toHaveTrait: .italicFontMask)
    }()

    /// Returns the `NSColor` for the given syntax token type.
    static func nsColor(for tokenType: SyntaxTokenType) -> NSColor {
        NSColor(color(for: tokenType))
    }

    /// Tokenizes `text` for `language` and returns an `AttributedString` with
    /// syntax-colored foreground colors and appropriate font variants.
    ///
    /// This function is `nonisolated` — it does not require the main actor and
    /// participates in structured concurrency when called from a child `Task`.
    /// All font and color lookups use pre-cached static constants.
    nonisolated static func highlight(_ text: String, language: SyntaxLanguage) -> AttributedString {
        var attributedString = AttributedString(text)
        attributedString.foregroundColor = defaultForeground
        attributedString.font = baseFont

        guard language != .plain, text.utf8.count <= maxHighlightSize else {
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
                attributedString[attrRange].font = boldFont
            case .italic:
                attributedString[attrRange].font = italicFont
            default:
                break
            }
        }

        return attributedString
    }

    // MARK: - NSAttributedString (for NSTextView)

    /// Tokenizes `text` and returns an `NSAttributedString` suitable for display
    /// in an `NSTextView`. Uses pre-cached `NSFont` / `NSColor` values.
    ///
    /// Safe to call from any thread — all font/color lookups are static.
    nonisolated static func highlightNS(
        _ text: String,
        language: SyntaxLanguage,
        paragraphStyle: NSParagraphStyle? = nil
    ) -> NSAttributedString {
        var baseAttrs: [NSAttributedString.Key: Any] = [
            .font: nsFont,
            .foregroundColor: NSColor(VColor.contentDefault),
        ]
        if let ps = paragraphStyle {
            baseAttrs[.paragraphStyle] = ps
        }

        let result = NSMutableAttributedString(string: text, attributes: baseAttrs)

        guard language != .plain, text.utf8.count <= maxHighlightSize else {
            return result
        }

        let tokens = SyntaxTokenizer.tokenize(text, language: language)

        for token in tokens {
            guard let range = Range(token.range, in: text) else { continue }
            let nsRange = NSRange(range, in: text)

            result.addAttribute(.foregroundColor, value: nsColor(for: token.type), range: nsRange)

            switch token.type {
            case .heading, .bold:
                result.addAttribute(.font, value: nsBoldFont, range: nsRange)
            case .italic:
                result.addAttribute(.font, value: nsItalicFont, range: nsRange)
            default:
                break
            }
        }

        return result
    }
}
