import SwiftUI
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
        let baseFont = Font.custom("DMMono-Regular", size: 13)

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
                attributedString[attrRange].font = Font.custom("DMMono-Regular", size: 13).bold()
            case .italic:
                attributedString[attrRange].font = Font.custom("DMMono-Regular", size: 13).italic()
            default:
                break
            }
        }

        return attributedString
    }
}
