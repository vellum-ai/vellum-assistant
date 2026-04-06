import Foundation

/// Attaches `.link` attributes to bare URLs in AttributedStrings produced by
/// Foundation's markdown parser. The parser (with `.inlineOnlyPreservingWhitespace`)
/// only recognizes explicit `[text](url)` syntax; this fills the autolink gap
/// so that URLs like "amazon.com/dp/B07978VPPH" become clickable in chat.
///
/// `NSDataDetector` handles schemeless URLs by synthesizing an `http://`
/// scheme; the browser then upgrades to HTTPS as needed.
enum AttributedStringAutolinker {
    /// Shared detector — `NSDataDetector` is expensive to construct.
    private static let urlDetector: NSDataDetector? = {
        try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue)
    }()

    /// Characters that commonly trail a URL in natural prose but aren't
    /// part of the URL itself.
    private static let trailingPunctuationToTrim = CharacterSet(charactersIn: ".,;:!?)>\"'")

    /// Adds `.link` attributes to bare URLs, preserving existing links and
    /// skipping code spans. No-op when no bare URLs are present.
    static func autolinkBareURLs(in attributed: inout AttributedString) {
        guard let detector = urlDetector else { return }

        let plainText = String(attributed.characters)
        let nsRange = NSRange(plainText.startIndex..., in: plainText)
        let matches = detector.matches(in: plainText, options: [], range: nsRange)
        guard !matches.isEmpty else { return }

        for match in matches {
            guard let url = match.url,
                  let swiftRange = Range(match.range, in: plainText),
                  let lo = AttributedString.Index(swiftRange.lowerBound, within: attributed),
                  let hi = AttributedString.Index(swiftRange.upperBound, within: attributed),
                  lo < hi else { continue }

            let attrRange = lo..<hi

            // Skip ranges already linked or inside inline code spans.
            var skip = false
            for run in attributed[attrRange].runs {
                if run.link != nil { skip = true; break }
                if let intent = run.inlinePresentationIntent, intent.contains(.code) {
                    skip = true; break
                }
            }
            if skip { continue }

            let cleaned = trimTrailingPunctuation(url)
            let trimmedCount = url.absoluteString.count - cleaned.absoluteString.count

            if trimmedCount > 0,
               let newEnd = attributed.characters.index(
                   hi, offsetBy: -trimmedCount, limitedBy: lo
               ) {
                attributed[lo..<newEnd].link = cleaned
            } else {
                attributed[attrRange].link = cleaned
            }
        }
    }

    /// Strips trailing prose punctuation from a URL that `NSDataDetector`
    /// may have over-eagerly included.
    private static func trimTrailingPunctuation(_ url: URL) -> URL {
        var str = url.absoluteString

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
