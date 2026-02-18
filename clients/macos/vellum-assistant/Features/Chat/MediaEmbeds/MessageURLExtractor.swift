import Foundation

/// Extracts plain `http` / `https` URLs from message text.
///
/// This is the first stage of the media-embed pipeline: deterministic,
/// regex-based URL discovery with no markdown awareness (markdown link
/// syntax handling is layered on top in a later stage).
enum MessageURLExtractor {

    // Characters that commonly trail a URL in natural prose but aren't
    // part of the URL itself.
    private static let trailingPunctuationToTrim: CharacterSet = CharacterSet(charactersIn: ".,;!>\"')")

    /// Extracts all distinct `http(s)://` URLs from `text`, returned in
    /// first-occurrence order. Duplicates are suppressed (first wins).
    static func extractPlainURLs(from text: String) -> [URL] {
        guard let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue) else {
            return []
        }

        let nsRange = NSRange(text.startIndex..., in: text)
        let matches = detector.matches(in: text, options: [], range: nsRange)

        var seen = Set<String>()
        var results: [URL] = []

        for match in matches {
            guard let url = match.url else { continue }

            let scheme = url.scheme?.lowercased() ?? ""
            guard scheme == "http" || scheme == "https" else { continue }

            // NSDataDetector sometimes includes trailing punctuation that
            // belongs to the surrounding prose rather than the URL.
            let cleaned = trimTrailingPunctuation(url)

            let canonical = cleaned.absoluteString
            guard !seen.contains(canonical) else { continue }
            seen.insert(canonical)
            results.append(cleaned)
        }

        return results
    }

    // Matches markdown-style links: [text](url) and [text](url "title")
    // The URL group captures everything up to the first closing paren,
    // optional whitespace, optional quoted title, then the final paren.
    private static let markdownLinkPattern: NSRegularExpression = {
        // Captures: [any text](url) or [any text](url "title")
        // Group 1 = the URL portion (before optional whitespace + title).
        let pattern = #"\[(?:[^\[\]]|\[.*?\])*\]\(\s*((?:[^()\s"]+|\([^)]*\))+)(?:\s+"[^"]*")?\s*\)"#
        return try! NSRegularExpression(pattern: pattern, options: [])
    }()

    /// Extracts `http(s)://` URLs that appear as markdown link targets
    /// (`[text](url)`) in `text`, returned in first-occurrence order.
    static func extractMarkdownLinkURLs(from text: String) -> [URL] {
        let nsRange = NSRange(text.startIndex..., in: text)
        let matches = markdownLinkPattern.matches(in: text, options: [], range: nsRange)

        var seen = Set<String>()
        var results: [URL] = []

        for match in matches {
            guard match.numberOfRanges >= 2,
                  let urlRange = Range(match.range(at: 1), in: text) else {
                continue
            }

            let rawURL = String(text[urlRange])
            guard let url = URL(string: rawURL) else { continue }

            let scheme = url.scheme?.lowercased() ?? ""
            guard scheme == "http" || scheme == "https" else { continue }

            let canonical = url.absoluteString
            guard !seen.contains(canonical) else { continue }
            seen.insert(canonical)
            results.append(url)
        }

        return results
    }

    // Matches fenced code blocks: ``` with optional language id, content, closing ```
    // Uses dotMatchesLineSeparators so `.` spans newlines.
    private static let fencedCodeBlockPattern: NSRegularExpression = {
        let pattern = "```[^`\\n]*\\n[\\s\\S]*?```"
        return try! NSRegularExpression(pattern: pattern, options: [])
    }()

    // Matches inline code spans: `...` (single backtick, no nesting).
    // Avoids matching empty backtick pairs or fenced blocks.
    private static let inlineCodePattern: NSRegularExpression = {
        let pattern = "`[^`]+`"
        return try! NSRegularExpression(pattern: pattern, options: [])
    }()

    /// Removes fenced code blocks and inline code spans so that URLs
    /// inside them are not picked up by extraction. Fenced blocks are
    /// stripped first so that backticks inside fences don't interfere
    /// with inline-code matching.
    static func stripCodeRegions(from text: String) -> String {
        let mutable = NSMutableString(string: text)
        let fullRange = NSRange(location: 0, length: mutable.length)

        // Strip fenced blocks first (they may contain backticks).
        fencedCodeBlockPattern.replaceMatches(in: mutable, options: [], range: fullRange, withTemplate: "")

        // Then strip inline code spans from what remains.
        let updatedRange = NSRange(location: 0, length: mutable.length)
        inlineCodePattern.replaceMatches(in: mutable, options: [], range: updatedRange, withTemplate: "")

        return mutable as String
    }

    /// Combines plain-text and markdown-link URL extraction, returning a
    /// deduplicated list in first-occurrence order across both sources.
    /// URLs inside inline code spans and fenced code blocks are excluded.
    static func extractAllURLs(from text: String) -> [URL] {
        let stripped = stripCodeRegions(from: text)

        let plain = extractPlainURLs(from: stripped)
        let markdown = extractMarkdownLinkURLs(from: stripped)

        var seen = Set<String>()
        var results: [URL] = []

        for url in plain {
            let canonical = url.absoluteString
            guard !seen.contains(canonical) else { continue }
            seen.insert(canonical)
            results.append(url)
        }

        for url in markdown {
            let canonical = url.absoluteString
            guard !seen.contains(canonical) else { continue }
            seen.insert(canonical)
            results.append(url)
        }

        return results
    }

    /// Strips trailing prose punctuation from a URL that NSDataDetector
    /// may have over-eagerly included.
    private static func trimTrailingPunctuation(_ url: URL) -> URL {
        var str = url.absoluteString

        // Repeatedly strip a single trailing character while it matches.
        while let last = str.unicodeScalars.last,
              trailingPunctuationToTrim.contains(last) {
            // Don't strip a closing paren if there's a matching opening
            // paren earlier in the URL (common in Wikipedia links).
            if last == ")" {
                let openCount = str.filter { $0 == "(" }.count
                let closeCount = str.filter { $0 == ")" }.count
                if openCount >= closeCount { break }
            }
            str = String(str.dropLast())
        }

        return URL(string: str) ?? url
    }
}
