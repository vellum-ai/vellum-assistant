import Foundation

// MARK: - MarkdownListItem

/// A single list item with indentation and ordering context.
public struct MarkdownListItem {
    public let indent: Int
    public let ordered: Bool
    public let number: Int      // meaningful only when ordered == true
    public let text: String

    public init(indent: Int, ordered: Bool, number: Int, text: String) {
        self.indent = indent
        self.ordered = ordered
        self.number = number
        self.text = text
    }
}

// MARK: - MarkdownBlock

/// A parsed block-level markdown element.
public enum MarkdownBlock {
    case text(String)
    case heading(level: Int, text: String)
    case codeBlock(language: String?, code: String)
    case list(items: [MarkdownListItem])
    case table(headers: [String], rows: [[String]])
    case image(alt: String, url: String)
    case horizontalRule
}

// MARK: - MarkdownBlockParser

/// Block-level markdown parser with support for headings, code blocks (``` and ~~~),
/// tables, images, lists, and horizontal rules.
public enum MarkdownBlockParser {

    // MARK: - Public API

    public static func parse(_ text: String) -> [MarkdownBlock] {
        let lines = text.components(separatedBy: .newlines)
        var blocks: [MarkdownBlock] = []
        var currentText: [String] = []
        var i = 0
        var fenceDelimiter: (character: Character, length: Int)?
        var codeBlockLanguage: String?
        var codeBlockLines: [String] = []

        func flushText() {
            let pending = currentText.joined(separator: "\n")
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if !pending.isEmpty {
                blocks.append(.text(pending))
            }
            currentText = []
        }

        while i < lines.count {
            let trimmed = lines[i].trimmingCharacters(in: .whitespaces)

            // --- Inside a fenced code block ---
            if let fence = fenceDelimiter {
                let closeCount = trimmed.prefix(while: { $0 == fence.character }).count
                if closeCount >= fence.length
                    && trimmed.drop(while: { $0 == fence.character }).allSatisfy(\.isWhitespace) {
                    fenceDelimiter = nil
                    blocks.append(.codeBlock(language: codeBlockLanguage,
                                             code: codeBlockLines.joined(separator: "\n")))
                    codeBlockLines = []
                    codeBlockLanguage = nil
                } else {
                    codeBlockLines.append(lines[i])
                }
                i += 1
                continue
            }

            // --- Opening a new fence (``` or ~~~) ---
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
                blocks.append(.table(headers: headers, rows: rows))
                continue
            }

            // --- Heading detection ---
            if let heading = parseHeading(lines[i]) {
                flushText()
                blocks.append(.heading(level: heading.level, text: heading.text))
                i += 1
                continue
            }

            // --- Horizontal rule detection ---
            if isHorizontalRule(trimmed) {
                flushText()
                blocks.append(.horizontalRule)
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
                blocks.append(.list(items: items))
                continue
            }

            // Empty lines: accumulate into currentText to preserve paragraph spacing
            // (avoids splitting multi-paragraph prose into separate .text blocks)

            // --- Plain text ---
            currentText.append(lines[i])
            i += 1
        }

        // If a fence was never closed, emit accumulated code block lines as text
        if fenceDelimiter != nil {
            let fenceChar = fenceDelimiter!.character
            let fenceLen = fenceDelimiter!.length
            let opener = String(repeating: String(fenceChar), count: fenceLen) + (codeBlockLanguage ?? "")
            currentText.append(opener)
            currentText.append(contentsOf: codeBlockLines)
        }

        flushText()

        // Post-process paragraphs to extract inline images.
        return blocks.flatMap { block -> [MarkdownBlock] in
            if case .text(let content) = block {
                return extractImageBlocks(from: content)
            }
            return [block]
        }
    }

    // MARK: - Heading

    public static func parseHeading(_ line: String) -> (level: Int, text: String)? {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        let hashes = trimmed.prefix(while: { $0 == "#" })
        let level = hashes.count
        guard level >= 1, level <= 6 else { return nil }
        let rest = trimmed.dropFirst(level)
        guard rest.first == " " else { return nil }
        return (level, String(rest.dropFirst()).trimmingCharacters(in: .whitespaces))
    }

    // MARK: - Horizontal Rule

    public static func isHorizontalRule(_ line: String) -> Bool {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        let stripped = trimmed.filter { !$0.isWhitespace }
        guard stripped.count >= 3 else { return false }
        guard let ch = stripped.first, (ch == "-" || ch == "*" || ch == "_") else { return false }
        return stripped.allSatisfy { $0 == ch }
    }

    // MARK: - List

    public static func parseListLine(_ line: String) -> MarkdownListItem? {
        var indent = 0
        for ch in line {
            if ch == " " { indent += 1 }
            else if ch == "\t" { indent += 4 }
            else { break }
        }
        let trimmed = line.trimmingCharacters(in: .whitespaces)

        // Unordered: `- `, `* `, `+ `
        if trimmed.hasPrefix("- ") || trimmed.hasPrefix("* ") || trimmed.hasPrefix("+ ") {
            return MarkdownListItem(indent: indent, ordered: false, number: 0,
                                    text: String(trimmed.dropFirst(2)))
        }
        // Ordered: `1. `, `2. `, etc.
        let digits = trimmed.prefix(while: { $0.isNumber })
        if !digits.isEmpty {
            let rest = trimmed.dropFirst(digits.count)
            if rest.hasPrefix(". ") {
                return MarkdownListItem(indent: indent, ordered: true,
                                        number: Int(digits) ?? 1,
                                        text: String(rest.dropFirst(2)))
            }
        }
        return nil
    }

    // MARK: - Table

    public static func isTableRow(_ line: String) -> Bool {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        return trimmed.hasPrefix("|") && trimmed.hasSuffix("|")
            && trimmed.filter({ $0 == "|" }).count >= 2
    }

    public static func isTableSeparator(_ line: String) -> Bool {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        guard trimmed.hasPrefix("|") && trimmed.hasSuffix("|") else { return false }
        let inner = trimmed.dropFirst().dropLast()
        return inner.split(separator: "|").allSatisfy { cell in
            let c = cell.trimmingCharacters(in: .whitespaces)
            return !c.isEmpty && c.allSatisfy({ $0 == "-" || $0 == ":" })
        }
    }

    public static func parseTableCells(_ line: String) -> [String] {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        let inner = String(trimmed.dropFirst().dropLast())
        return inner.components(separatedBy: "|")
            .map { $0.trimmingCharacters(in: .whitespaces) }
    }

    // MARK: - Image extraction

    public static func extractImageBlocks(from text: String) -> [MarkdownBlock] {
        let pattern = #"!\[([^\]]*)\]\(([^)]+)\)"#
        guard let regex = try? NSRegularExpression(pattern: pattern) else {
            return [.text( text)]
        }

        let nsText = text as NSString
        let matches = regex.matches(in: text, range: NSRange(location: 0, length: nsText.length))

        if matches.isEmpty { return [.text( text)] }

        var blocks: [MarkdownBlock] = []
        var lastEnd = 0

        for match in matches {
            if match.range.location > lastEnd {
                let before = nsText.substring(with: NSRange(location: lastEnd,
                                                            length: match.range.location - lastEnd))
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                if !before.isEmpty {
                    blocks.append(.text( before))
                }
            }

            let alt = nsText.substring(with: match.range(at: 1))
            let url = nsText.substring(with: match.range(at: 2))
            blocks.append(.image(alt: alt, url: url))

            lastEnd = match.range.location + match.range.length
        }

        if lastEnd < nsText.length {
            let after = nsText.substring(from: lastEnd)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if !after.isEmpty {
                blocks.append(.text( after))
            }
        }

        return blocks
    }
}
