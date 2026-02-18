import Foundation

/// Extracts plain `http` / `https` URLs from message text.
///
/// This is the first stage of the media-embed pipeline: deterministic,
/// regex-based URL discovery with no markdown awareness (markdown link
/// syntax handling is layered on top in a later stage).
enum MessageURLExtractor {

    // Characters that commonly trail a URL in natural prose but aren't
    // part of the URL itself.
    private static let trailingPunctuationToTrim: CharacterSet = CharacterSet(charactersIn: ".,;:!?)>\"'")

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
