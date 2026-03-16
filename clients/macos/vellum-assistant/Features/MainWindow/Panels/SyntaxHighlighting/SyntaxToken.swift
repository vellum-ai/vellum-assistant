import Foundation

/// Token types produced by the syntax tokenizer.
enum SyntaxTokenType: String, CaseIterable {
    case keyword
    case string
    case comment
    case number
    case type
    case property
    case punctuation
    case boolean
    case null
    case heading
    case bold
    case italic
    case codeSpan
    case link
    case plain
}
