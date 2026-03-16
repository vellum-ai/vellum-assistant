import Foundation

/// Regex-based syntax tokenizer that produces non-overlapping, sorted token ranges.
struct SyntaxTokenizer {

    /// Tokenizes the given text for the specified language.
    ///
    /// Returns an array of `(range, type)` tuples sorted by range location.
    /// Ranges are non-overlapping; earlier patterns in the priority list win
    /// when two patterns match the same region.
    static func tokenize(_ text: String, language: SyntaxLanguage) -> [(range: NSRange, type: SyntaxTokenType)] {
        switch language {
        case .javascript, .typescript:
            return tokenizeJavaScript(text)
        case .json:
            return tokenizeJSON(text)
        case .markdown:
            return tokenizeMarkdown(text)
        case .plain:
            return []
        }
    }

    // MARK: - JavaScript / TypeScript

    private static func tokenizeJavaScript(_ text: String) -> [(range: NSRange, type: SyntaxTokenType)] {
        let patterns: [(pattern: String, type: SyntaxTokenType, options: NSRegularExpression.Options)] = [
            // Template literals (before comments so `//` inside templates is not misidentified)
            (#"`[^`]*`"#, .string, []),
            // Double-quoted strings (before comments so `//` inside strings is not misidentified)
            (#""(?:[^"\\]|\\.)*""#, .string, []),
            // Single-quoted strings (before comments so `//` inside strings is not misidentified)
            (#"'(?:[^'\\]|\\.)*'"#, .string, []),
            // Block comments
            (#"/\*[\s\S]*?\*/"#, .comment, [.dotMatchesLineSeparators]),
            // Line comments
            (#"//[^\n]*"#, .comment, []),
            // Numbers
            (#"\b(?:0[xX][0-9a-fA-F]+|0[bB][01]+|0[oO][0-7]+|\d+\.?\d*(?:[eE][+-]?\d+)?)\b"#, .number, []),
            // Booleans
            (#"\b(?:true|false)\b"#, .boolean, []),
            // Null/undefined
            (#"\b(?:null|undefined)\b"#, .null, []),
            // JS keywords
            (#"\b(?:const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|class|extends|new|this|super|import|export|from|default|async|await|try|catch|finally|throw|typeof|instanceof|in|of|void|delete|yield)\b"#, .keyword, []),
            // TS keywords
            (#"\b(?:interface|type|enum|namespace|readonly|as|is|keyof|infer|implements|declare|abstract|private|protected|public|static|override)\b"#, .keyword, []),
            // Type-like identifiers (PascalCase)
            (#"\b[A-Z][a-zA-Z0-9]*\b"#, .type, []),
        ]

        return applyPatterns(patterns, to: text)
    }

    // MARK: - JSON

    private static func tokenizeJSON(_ text: String) -> [(range: NSRange, type: SyntaxTokenType)] {
        let patterns: [(pattern: String, type: SyntaxTokenType, options: NSRegularExpression.Options)] = [
            // String keys (strings followed by `:`)
            (#""(?:[^"\\]|\\.)*"(?=\s*:)"#, .property, []),
            // String values
            (#""(?:[^"\\]|\\.)*""#, .string, []),
            // Numbers
            (#"-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?"#, .number, []),
            // Booleans
            (#"\b(?:true|false)\b"#, .boolean, []),
            // Null
            (#"\bnull\b"#, .null, []),
        ]

        return applyPatterns(patterns, to: text)
    }

    // MARK: - Markdown

    private static func tokenizeMarkdown(_ text: String) -> [(range: NSRange, type: SyntaxTokenType)] {
        let patterns: [(pattern: String, type: SyntaxTokenType, options: NSRegularExpression.Options)] = [
            // Code fences
            (#"```[\s\S]*?```"#, .codeSpan, [.dotMatchesLineSeparators]),
            // Inline code
            (#"`[^`\n]+`"#, .codeSpan, []),
            // Headings
            (#"^#{1,6}\s.*$"#, .heading, [.anchorsMatchLines]),
            // Bold
            (#"\*\*[^*]+\*\*"#, .bold, []),
            // Italic (avoiding bold)
            (#"(?<!\*)\*(?!\*)[^*]+(?<!\*)\*(?!\*)"#, .italic, []),
            // Links
            (#"\[.*?\]\(.*?\)"#, .link, []),
        ]

        return applyPatterns(patterns, to: text)
    }

    // MARK: - Shared Pattern Application

    /// Applies regex patterns in priority order, skipping matches that overlap
    /// with already-collected ranges.
    private static func applyPatterns(
        _ patterns: [(pattern: String, type: SyntaxTokenType, options: NSRegularExpression.Options)],
        to text: String
    ) -> [(range: NSRange, type: SyntaxTokenType)] {
        let nsText = text as NSString
        let fullRange = NSRange(location: 0, length: nsText.length)
        var tokens: [(range: NSRange, type: SyntaxTokenType)] = []

        for (pattern, type, options) in patterns {
            guard let regex = try? NSRegularExpression(pattern: pattern, options: options) else {
                continue
            }

            let matches = regex.matches(in: text, options: [], range: fullRange)
            for match in matches {
                let range = match.range
                guard range.length > 0 else { continue }

                let overlaps = tokens.contains { existing in
                    NSIntersectionRange(existing.range, range).length > 0
                }

                if !overlaps {
                    tokens.append((range: range, type: type))
                }
            }
        }

        tokens.sort { $0.range.location < $1.range.location }
        return tokens
    }
}
