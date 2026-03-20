import Foundation

/// Actor that wraps `MessageURLExtractor.extractAllURLs(from:)` with an
/// in-memory cache, moving the expensive `NSDataDetector` work off
/// the main thread via actor isolation.
///
/// Backed by `NSCache`, which automatically evicts entries under memory
/// pressure — no manual LRU bookkeeping required.
public actor URLExtractionCache {
    public static let shared = URLExtractionCache()

    /// Wraps `[URL]` so it can be stored in `NSCache`.
    private class CacheEntry: NSObject {
        let urls: [URL]
        init(_ urls: [URL]) {
            self.urls = urls
        }
    }

    private let cache = NSCache<NSString, CacheEntry>()

    private init() {
        cache.countLimit = 500
    }

    public func extractAllURLs(from text: String) -> [URL] {
        let key = text as NSString

        if let cached = cache.object(forKey: key) {
            return cached.urls
        }

        let result = MessageURLExtractor.extractAllURLs(from: text)
        cache.setObject(CacheEntry(result), forKey: key)
        return result
    }

    /// Removes all cached entries.
    public func clearCache() {
        cache.removeAllObjects()
    }
}

/// Extracts plain `http` / `https` URLs from message text.
///
/// This is the first stage of the media-embed pipeline: deterministic,
/// regex-based URL discovery with no markdown awareness (markdown link
/// syntax handling is layered on top in a later stage).
public enum MessageURLExtractor {

    // Characters that commonly trail a URL in natural prose but aren't
    // part of the URL itself.
    private static let trailingPunctuationToTrim: CharacterSet = CharacterSet(charactersIn: ".,;:!?)>\"'")

    /// Extracts all distinct `http(s)://` URLs from `text`, returned in
    /// first-occurrence order. Duplicates are suppressed (first wins).
    public static func extractPlainURLs(from text: String) -> [URL] {
        extractPlainURLsWithPositions(from: text).map(\.url)
    }

    /// Returns plain-text URLs paired with their UTF-16 offset in
    /// `text`, used by `extractAllURLs` to merge-sort with markdown URLs.
    private static func extractPlainURLsWithPositions(from text: String) -> [(url: URL, position: Int)] {
        guard let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue) else {
            return []
        }

        let nsRange = NSRange(text.startIndex..., in: text)
        let matches = detector.matches(in: text, options: [], range: nsRange)

        var seen = Set<String>()
        var results: [(url: URL, position: Int)] = []

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
            results.append((url: cleaned, position: match.range.location))
        }

        return results
    }

    // Matches markdown-style links: [text](url) and [text](url "title")
    // The URL group supports up to 2 levels of nested parentheses in the
    // URL (e.g. Wikipedia: `Swift_(programming_language_(nested))`).
    //
    // All inner quantifiers use possessive modifiers (`++`, `*+`) to
    // prevent catastrophic backtracking. Without them the nested
    // `[^()\s"]+` inside the outer `(?:…)+` forms the classic `(a+)+`
    // pattern, causing exponential runtime on malformed input (e.g. a
    // long URL-like string with unbalanced parentheses).  Possessive
    // quantifiers are supported by the ICU regex engine backing
    // NSRegularExpression and are safe here because the alternation
    // branches never overlap in which characters they consume.
    private static let markdownLinkPattern: NSRegularExpression = {
        // paren2 matches innermost balanced parens: (...)
        // paren1 matches one level up, allowing paren2 inside: (...(...))
        // The URL is one or more non-special chars or paren1 groups.
        let paren2 = #"\([^()]*+\)"#
        let paren1 = #"\((?:[^()]*+|\#(paren2))*+\)"#
        let urlBody = #"(?:[^()\s"]++|\#(paren1))++"#
        let pattern = #"\[(?:[^\[\]]|\[.*?\])*\]\(\s*(\#(urlBody))(?:\s+"[^"]*")?\s*\)"#
        return try! NSRegularExpression(pattern: pattern, options: [])
    }()

    /// Extracts `http(s)://` URLs that appear as markdown link targets
    /// (`[text](url)`) in `text`, returned in first-occurrence order.
    public static func extractMarkdownLinkURLs(from text: String) -> [URL] {
        extractMarkdownLinkURLsWithPositions(from: text).map(\.url)
    }

    /// Returns markdown-link URLs paired with their UTF-16 offset in
    /// `text`, used by `extractAllURLs` to merge-sort with plain URLs.
    private static func extractMarkdownLinkURLsWithPositions(from text: String) -> [(url: URL, position: Int)] {
        let nsRange = NSRange(text.startIndex..., in: text)
        let matches = markdownLinkPattern.matches(in: text, options: [], range: nsRange)

        var seen = Set<String>()
        var results: [(url: URL, position: Int)] = []

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

            let position = match.range(at: 1).location
            results.append((url: url, position: position))
        }

        return results
    }

    // Matches fenced code blocks: ``` with optional language id, content, closing ```.
    // Also matches unterminated fences (opening ``` with no closing ```) by
    // consuming from the opening fence to end-of-string.
    private static let fencedCodeBlockPattern: NSRegularExpression = {
        let pattern = "```[^`\\n]*\\n(?:[\\s\\S]*?```|[\\s\\S]*$)"
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
    ///
    /// Matches are replaced with a single space (not an empty string)
    /// to preserve token boundaries — otherwise surrounding text could
    /// concatenate into a spurious URL.
    public static func stripCodeRegions(from text: String) -> String {
        let mutable = NSMutableString(string: text)
        let fullRange = NSRange(location: 0, length: mutable.length)

        // Strip fenced blocks first (they may contain backticks).
        fencedCodeBlockPattern.replaceMatches(in: mutable, options: [], range: fullRange, withTemplate: " ")

        // Then strip inline code spans from what remains.
        let updatedRange = NSRange(location: 0, length: mutable.length)
        inlineCodePattern.replaceMatches(in: mutable, options: [], range: updatedRange, withTemplate: " ")

        return mutable as String
    }

    /// Combines plain-text and markdown-link URL extraction, returning a
    /// deduplicated list in first-occurrence order across both sources.
    /// URLs inside inline code spans and fenced code blocks are excluded.
    public static func extractAllURLs(from text: String) -> [URL] {
        let stripped = stripCodeRegions(from: text)

        let plain = extractPlainURLsWithPositions(from: stripped)
        let markdown = extractMarkdownLinkURLsWithPositions(from: stripped)

        // Merge both lists, sort by position, then deduplicate.
        var combined = plain + markdown
        combined.sort { $0.position < $1.position }

        var seen = Set<String>()
        var results: [URL] = []

        for entry in combined {
            let canonical = entry.url.absoluteString
            guard !seen.contains(canonical) else { continue }
            seen.insert(canonical)
            results.append(entry.url)
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
