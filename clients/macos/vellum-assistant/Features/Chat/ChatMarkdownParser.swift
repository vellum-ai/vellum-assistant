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

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Header row
            HStack(spacing: 0) {
                // ⚠️ Do NOT replace HStack+Spacer with .frame(maxWidth:, alignment:) here.
                // FlexFrame alignment queries recurse through all children — see AGENTS.md.
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
        // ⚠️ Do NOT replace .frame(width:) with .frame(maxWidth:, alignment:) here.
        // FlexFrame alignment queries recurse through all children — see AGENTS.md.
        .frame(width: maxWidth.isFinite ? maxWidth : nil, alignment: .leading)
    }

    private func inlineMarkdownCell(_ text: String) -> some View {
        let attributed = Self.cachedAttributedString(for: text)
        return Text(attributed)
            .font(VFont.bodyMediumLighter)
            .foregroundStyle(VColor.contentDefault)
            .textSelection(.enabled)
            .lineLimit(nil)
            .fixedSize(horizontal: false, vertical: true)
    }
}
