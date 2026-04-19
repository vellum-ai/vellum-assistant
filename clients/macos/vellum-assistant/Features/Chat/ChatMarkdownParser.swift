import os
import SwiftUI
import VellumAssistantShared

// MARK: - Markdown Table Support

/// A segment of message content — either plain text or a parsed table.
struct MarkdownListItem: Hashable {
    let indent: Int
    let ordered: Bool
    let number: Int      // meaningful only when ordered == true
    let text: String
}

enum MarkdownSegment: Hashable {
    case text(String)
    case table(headers: [String], rows: [[String]])
    case image(alt: String, url: String)
    case heading(level: Int, text: String)
    case codeBlock(language: String?, code: String)
    case horizontalRule
    case list(items: [MarkdownListItem])
    /// Block-level LaTeX math (delimited by `$$...$$`). `display: true` means
    /// block/display math; the field is plumbed through now so a future
    /// inline-math (`$...$`) pass can reuse the same case with `display: false`.
    case math(latex: String, display: Bool)
}

/// Returns true if `line` is a markdown heading (1-6 `#` chars followed by a space).
func isHeadingLine(_ line: String) -> (level: Int, text: String)? {
    let trimmed = line.trimmingCharacters(in: .whitespaces)
    let hashes = trimmed.prefix(while: { $0 == "#" })
    let level = hashes.count
    guard level >= 1, level <= 6 else { return nil }
    let rest = trimmed.dropFirst(level)
    guard rest.first == " " else { return nil }
    return (level, String(rest.dropFirst()).trimmingCharacters(in: .whitespaces))
}

/// Returns true if `line` is a horizontal rule (`---`, `***`, or `___` with 3+ chars).
func isHorizontalRule(_ line: String) -> Bool {
    let trimmed = line.trimmingCharacters(in: .whitespaces)
    let stripped = trimmed.filter { !$0.isWhitespace }
    guard stripped.count >= 3 else { return false }
    guard let ch = stripped.first, (ch == "-" || ch == "*" || ch == "_") else { return false }
    return stripped.allSatisfy { $0 == ch }
}

/// Returns a `MarkdownListItem` if the line looks like a list entry, otherwise nil.
func parseListLine(_ line: String) -> MarkdownListItem? {
    // Measure indent (count leading spaces, tabs count as 4)
    var indent = 0
    for ch in line {
        if ch == " " { indent += 1 }
        else if ch == "\t" { indent += 4 }
        else { break }
    }
    let trimmed = line.trimmingCharacters(in: .whitespaces)

    // Unordered: `- `, `* `, `+ `
    if (trimmed.hasPrefix("- ") || trimmed.hasPrefix("* ") || trimmed.hasPrefix("+ ")) {
        return MarkdownListItem(indent: indent, ordered: false, number: 0, text: String(trimmed.dropFirst(2)))
    }
    // Ordered: `1. `, `2. `, etc.
    let digits = trimmed.prefix(while: { $0.isNumber })
    if !digits.isEmpty {
        let rest = trimmed.dropFirst(digits.count)
        if rest.hasPrefix(". ") {
            return MarkdownListItem(indent: indent, ordered: true, number: Int(digits) ?? 1,
                            text: String(rest.dropFirst(2)))
        }
    }
    return nil
}

/// Parses message text into segments, extracting markdown tables, code blocks, headings, lists, and rules.
func parseMarkdownSegments(_ text: String) -> [MarkdownSegment] {
    os_signpost(.begin, log: PerfSignposts.log, name: "markdownParse")
    defer { os_signpost(.end, log: PerfSignposts.log, name: "markdownParse") }
    let lines = text.components(separatedBy: .newlines)
    var segments: [MarkdownSegment] = []
    var currentText: [String] = []
    var i = 0
    var fenceDelimiter: (character: Character, length: Int)? = nil
    var codeBlockLanguage: String? = nil
    var codeBlockLines: [String] = []

    func flushText() {
        let pending = currentText.joined(separator: "\n")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if !pending.isEmpty {
            segments.append(.text(pending))
        }
        currentText = []
    }

    while i < lines.count {
        let trimmed = lines[i].trimmingCharacters(in: .whitespaces)

        // --- Inside a fenced code block ---
        if let fence = fenceDelimiter {
            let closeCount = trimmed.prefix(while: { $0 == fence.character }).count
            if closeCount >= fence.length && trimmed.drop(while: { $0 == fence.character }).allSatisfy(\.isWhitespace) {
                // Closing fence — emit code block
                fenceDelimiter = nil
                segments.append(.codeBlock(language: codeBlockLanguage, code: codeBlockLines.joined(separator: "\n")))
                codeBlockLines = []
                codeBlockLanguage = nil
            } else {
                codeBlockLines.append(lines[i])
            }
            i += 1
            continue
        }

        // --- Opening a new fence ---
        if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") {
            flushText()
            let fenceChar = trimmed.first!
            let fenceLen = trimmed.prefix(while: { $0 == fenceChar }).count
            fenceDelimiter = (fenceChar, fenceLen)
            let lang = trimmed.dropFirst(fenceLen).trimmingCharacters(in: .whitespaces)
            codeBlockLanguage = lang.isEmpty ? nil : lang
            i += 1
            continue
        }

        // --- Block math detection (`$$...$$`) ---
        //
        // Handled BEFORE tables/headings/etc. but AFTER fenced-code handling so
        // `$$` inside a fenced code block stays verbatim. Two forms:
        //   1. Single-line: `$$<expr>$$` on one trimmed line (length > 4 and
        //      at least one non-`$` between the delimiters — guards against
        //      the degenerate `$$$$` input).
        //   2. Multi-line: a line that is exactly `$$` opens a block; the
        //      next line that is exactly `$$` closes it. Contents between
        //      are taken verbatim. If EOF is reached without a closing `$$`,
        //      we revert the collected lines back to plain text.
        if trimmed.hasPrefix("$$") && trimmed.hasSuffix("$$")
            && trimmed.count > 4
            && trimmed.dropFirst(2).dropLast(2).contains(where: { $0 != "$" }) {
            flushText()
            let inner = String(trimmed.dropFirst(2).dropLast(2))
                .trimmingCharacters(in: .whitespacesAndNewlines)
            segments.append(.math(latex: inner, display: true))
            i += 1
            continue
        }
        if trimmed == "$$" {
            // Multi-line block — scan forward for the closing `$$`.
            flushText()
            var mathLines: [String] = []
            var j = i + 1
            var closed = false
            while j < lines.count {
                if lines[j].trimmingCharacters(in: .whitespaces) == "$$" {
                    closed = true
                    break
                }
                mathLines.append(lines[j])
                j += 1
            }
            if closed {
                let latex = mathLines.joined(separator: "\n")
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                segments.append(.math(latex: latex, display: true))
                i = j + 1
                continue
            } else {
                // Unclosed — fall back to plain text. Restore the opening `$$`
                // and any collected lines to `currentText` so they render
                // verbatim (mirrors the unclosed-fence behavior of emitting
                // what we have instead of dropping content).
                currentText.append(lines[i])
                for line in mathLines {
                    currentText.append(line)
                }
                i = j
                continue
            }
        }

        // --- Table detection ---
        if i + 2 < lines.count,
           isTableRow(lines[i]),
           isTableSeparator(lines[i + 1]),
           isTableRow(lines[i + 2]) {
            flushText()
            let headers = parseTableCells(lines[i])
            i += 2  // skip separator
            var rows: [[String]] = []
            while i < lines.count, isTableRow(lines[i]) {
                let cells = parseTableCells(lines[i])
                let padded = Array(cells.prefix(headers.count))
                    + Array(repeating: "", count: max(0, headers.count - cells.count))
                rows.append(padded)
                i += 1
            }
            segments.append(.table(headers: headers, rows: rows))
            continue
        }

        // --- Heading detection ---
        if let heading = isHeadingLine(lines[i]) {
            flushText()
            segments.append(.heading(level: heading.level, text: heading.text))
            i += 1
            continue
        }

        // --- Horizontal rule detection ---
        if isHorizontalRule(trimmed) {
            flushText()
            segments.append(.horizontalRule)
            i += 1
            continue
        }

        // --- List detection (consecutive list lines) ---
        if parseListLine(lines[i]) != nil {
            flushText()
            var items: [MarkdownListItem] = []
            while i < lines.count, let item = parseListLine(lines[i]) {
                items.append(item)
                i += 1
            }
            segments.append(.list(items: items))
            continue
        }

        // --- Plain text ---
        currentText.append(lines[i])
        i += 1
    }

    // If a fence was never closed, emit as a code block (e.g. during streaming)
    if fenceDelimiter != nil {
        segments.append(.codeBlock(language: codeBlockLanguage, code: codeBlockLines.joined(separator: "\n")))
    }

    flushText()

    // Post-process .text segments to extract inline images.
    return segments.flatMap { segment -> [MarkdownSegment] in
        if case .text(let content) = segment {
            return extractImageSegments(from: content)
        }
        return [segment]
    }
}

/// Pre-compiled regex for matching inline markdown images `![alt](url)`.
/// Hoisted to a file-level constant so the pattern is compiled once at app launch.
private let imageRegex = try! NSRegularExpression(pattern: #"!\[([^\]]*)\]\(([^)]+)\)"#)

/// Splits text around `![alt](url)` matches, returning mixed `.text` / `.image` segments.
func extractImageSegments(from text: String) -> [MarkdownSegment] {
    let regex = imageRegex

    let nsText = text as NSString
    let matches = regex.matches(in: text, range: NSRange(location: 0, length: nsText.length))

    if matches.isEmpty { return [.text(text)] }

    var segments: [MarkdownSegment] = []
    var lastEnd = 0

    for match in matches {
        // Text before the image
        if match.range.location > lastEnd {
            let before = nsText.substring(with: NSRange(location: lastEnd, length: match.range.location - lastEnd))
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if !before.isEmpty {
                segments.append(.text(before))
            }
        }

        let alt = nsText.substring(with: match.range(at: 1))
        let url = nsText.substring(with: match.range(at: 2))
        segments.append(.image(alt: alt, url: url))

        lastEnd = match.range.location + match.range.length
    }

    // Text after the last image
    if lastEnd < nsText.length {
        let after = nsText.substring(from: lastEnd)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if !after.isEmpty {
            segments.append(.text(after))
        }
    }

    return segments
}

func isTableRow(_ line: String) -> Bool {
    let trimmed = line.trimmingCharacters(in: .whitespaces)
    return trimmed.hasPrefix("|") && trimmed.hasSuffix("|")
        && trimmed.filter({ $0 == "|" }).count >= 2
}

func isTableSeparator(_ line: String) -> Bool {
    let trimmed = line.trimmingCharacters(in: .whitespaces)
    guard trimmed.hasPrefix("|") && trimmed.hasSuffix("|") else { return false }
    let inner = trimmed.dropFirst().dropLast()
    // Each cell should be dashes (with optional colons for alignment)
    return inner.split(separator: "|").allSatisfy { cell in
        let c = cell.trimmingCharacters(in: .whitespaces)
        return !c.isEmpty && c.allSatisfy({ $0 == "-" || $0 == ":" })
    }
}

// MARK: - Async Markdown Parse Actor

/// Actor that runs markdown parsing off the main thread.
/// Used for large messages (>2000 chars) to avoid blocking scroll on cache miss.
actor MarkdownParseActor {
    static let shared = MarkdownParseActor()

    private let cache = NSCache<NSString, CacheEntry>()

    private class CacheEntry: NSObject {
        let segments: [MarkdownSegment]
        init(_ segments: [MarkdownSegment]) { self.segments = segments }
    }

    init() {
        cache.countLimit = 256
    }

    /// Text longer than this is parsed but not cached, matching
    /// ChatBubble's size guardrails to prevent oversized entries from
    /// evicting many smaller, more frequently accessed ones.
    private let maxCacheableTextLength = 10_000

    func parse(_ text: String) -> [MarkdownSegment] {
        let key = text as NSString
        if let cached = cache.object(forKey: key) {
            return cached.segments
        }
        let result = parseMarkdownSegments(text)
        if text.count <= maxCacheableTextLength {
            cache.setObject(CacheEntry(result), forKey: key)
        }
        return result
    }

    func clearCache() {
        cache.removeAllObjects()
    }
}

func parseTableCells(_ line: String) -> [String] {
    let trimmed = line.trimmingCharacters(in: .whitespaces)
    let inner = String(trimmed.dropFirst().dropLast())  // strip outer pipes
    return inner.components(separatedBy: "|")
        .map { $0.trimmingCharacters(in: .whitespaces) }
}

/// Renders a parsed markdown table.
struct MarkdownTableView: View {
    let headers: [String]
    let rows: [[String]]
    var maxWidth: CGFloat = VSpacing.chatBubbleMaxWidth
    /// When true, the table is the last still-growing block of a streaming
    /// message. Bypasses the height cache because partial tables arriving
    /// row-by-row must not have an intermediate height stamped in as the
    /// final size for later passes — that would collapse the LazyVStack
    /// slot and cause neighboring content to overlap.
    var isStreamingTail: Bool = false

    // MARK: - Table Cell AttributedString Cache

    /// Simple LRU cache for table cell inline markdown AttributedString results.
    /// Keyed by the cell text content. Uses a Dictionary for O(1) lookups with
    /// an access-time counter for LRU eviction.
    private static let cellCacheLimit = 200

    /// Dictionary-based LRU cache: O(1) lookups, evicts least-recently-used
    /// entry when the cache exceeds `cellCacheLimit`.
    @MainActor private static var cellCache: [String: (value: AttributedString, accessTime: Int)] = [:]
    @MainActor private static var cellCacheLruCounter: Int = 0

    @MainActor static func clearCellAttributedStringCache() {
        cellCache.removeAll()
        cellCacheLruCounter = 0
        heightCache.removeAll()
    }

    @MainActor private static func cachedAttributedString(for text: String) -> AttributedString {
        // O(1) lookup
        if let entry = cellCache[text] {
            cellCacheLruCounter += 1
            cellCache[text] = (entry.value, cellCacheLruCounter)
            return entry.value
        }

        // Parse and cache
        let options = AttributedString.MarkdownParsingOptions(
            interpretedSyntax: .inlineOnlyPreservingWhitespace
        )
        var attributed = (try? AttributedString(markdown: text, options: options))
            ?? AttributedString(text)
        AttributedStringAutolinker.autolinkBareURLs(in: &attributed)

        // Evict least-recently-used entry if over limit
        if cellCache.count >= cellCacheLimit {
            if let lruKey = cellCache.min(by: { $0.value.accessTime < $1.value.accessTime })?.key {
                cellCache.removeValue(forKey: lruKey)
            }
        }
        cellCacheLruCounter += 1
        cellCache[text] = (attributed, cellCacheLruCounter)

        return attributed
    }

    // MARK: - Height Cache
    //
    // During scrolling, LazyVStack.measureEstimates calls sizeThatFits on
    // each cell to estimate content height. For tables with N rows × M
    // columns, this triggers a recursive explicitAlignment cascade through
    // every nested VStack/HStack — O(N × M × depth) per measurement.
    //
    // By caching the rendered height after the first layout pass and
    // applying it as a definite .frame(width:height:), subsequent
    // sizeThatFits calls from measureEstimates return in O(1) because
    // _FrameLayout with both dimensions set doesn't query children.
    //
    // The cache is content-addressed (keyed by headers + rows + width),
    // so it works correctly across conversation switches — identical
    // tables produce cache hits regardless of which conversation they
    // appear in.
    //
    // References:
    // - WWDC23: Demystify SwiftUI performance (https://developer.apple.com/videos/play/wwdc2023/10160/)
    // - _FrameLayout vs _FlexFrameLayout alignment behavior (see AGENTS.md)

    @MainActor private static var heightCache: [Int: CGFloat] = [:]

    /// Content-based hash for height cache lookup. Includes maxWidth so
    /// window resizing naturally invalidates stale entries.
    private var contentHash: Int {
        var hasher = Hasher()
        hasher.combine(headers)
        hasher.combine(rows)
        hasher.combine(maxWidth)
        return hasher.finalize()
    }

    var body: some View {
        let usableWidth = maxWidth.isFinite
        let hash = usableWidth ? contentHash : 0
        let cachedHeight = (usableWidth && !isStreamingTail) ? Self.heightCache[hash] : nil

        // Default alignment (.center) avoids explicitAlignment(.leading)
        // queries during sizing. Rows are full-width HStacks with
        // Spacer(minLength: 0), so content is already left-aligned
        // internally — the VStack alignment is visually redundant but
        // was previously triggering O(N) alignment queries per pass.
        VStack(spacing: 0) {
            // Header row
            HStack(spacing: 0) {
                ForEach(Array(headers.enumerated()), id: \.offset) { _, header in
                    HStack(spacing: 0) {
                        Text(header)
                            .font(VFont.labelDefault)
                            .foregroundStyle(VColor.contentSecondary)
                            .textSelection(.enabled)
                        Spacer(minLength: 0)
                    }
                    .padding(VSpacing.sm)
                }
            }

            Divider().background(VColor.borderBase)

            // Data rows with separators between them
            ForEach(Array(rows.enumerated()), id: \.offset) { rowIdx, row in
                HStack(spacing: 0) {
                    ForEach(Array(row.enumerated()), id: \.offset) { _, cell in
                        HStack(spacing: 0) {
                            inlineMarkdownCell(cell)
                            Spacer(minLength: 0)
                        }
                        .padding(VSpacing.sm)
                    }
                }
                if rowIdx < rows.count - 1 {
                    Divider().background(VColor.borderBase.opacity(0.5))
                }
            }
        }
        .background(VColor.surfaceBase.opacity(0.5))
        .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.md)
                .stroke(VColor.borderBase, lineWidth: 0.5)
        )
        .onGeometryChange(for: CGFloat.self) { proxy in
            proxy.size.height
        } action: { newHeight in
            if usableWidth && !isStreamingTail {
                Self.heightCache[hash] = newHeight
            }
        }
        // ⚠️ No .frame(maxWidth:) in LazyVStack cells — see AGENTS.md.
        // Both width AND height are set (after first render) so _FrameLayout
        // returns the cached size in O(1) without querying children.
        .frame(
            width: maxWidth.isFinite ? maxWidth : nil,
            height: cachedHeight,
            alignment: .leading
        )
    }

    private func inlineMarkdownCell(_ text: String) -> some View {
        let attributed = Self.cachedAttributedString(for: text)
        return Text(attributed)
            .font(VFont.bodyMediumLighter)
            .foregroundStyle(VColor.contentDefault)
            .textSelection(.enabled)
            .lineLimit(nil)
    }
}
