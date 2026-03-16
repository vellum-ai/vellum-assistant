import Foundation

/// Supported languages for syntax highlighting.
enum SyntaxLanguage: String, CaseIterable {
    case javascript
    case typescript
    case json
    case markdown
    case plain

    /// Detects the syntax language from a file name and/or MIME type.
    ///
    /// File extension takes precedence over MIME type. Returns `.plain` if
    /// neither the extension nor the MIME type matches a known language.
    static func detect(fileName: String, mimeType: String) -> SyntaxLanguage {
        let ext = (fileName as NSString).pathExtension.lowercased()

        switch ext {
        case "js", "jsx", "mjs", "cjs":
            return .javascript
        case "ts", "tsx", "mts", "cts":
            return .typescript
        case "json":
            return .json
        case "md", "markdown":
            return .markdown
        default:
            break
        }

        let mime = mimeType.lowercased()
        switch mime {
        case "application/json":
            return .json
        case "application/javascript", "text/javascript":
            return .javascript
        case "application/typescript", "text/typescript":
            return .typescript
        case "text/markdown":
            return .markdown
        default:
            return .plain
        }
    }
}
