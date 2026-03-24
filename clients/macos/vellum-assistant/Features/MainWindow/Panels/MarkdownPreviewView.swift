import SwiftUI
import VellumAssistantShared

// MARK: - YAML Frontmatter

/// Parsed YAML frontmatter from a Markdown file.
private struct MarkdownFrontmatter {
    var name: String?
    var description: String?
    var compatibility: String?
    var emoji: String?
    var displayName: String?
}

/// Strips YAML frontmatter from markdown content, returning the parsed frontmatter and remaining body.
private func parseFrontmatter(_ text: String) -> (frontmatter: MarkdownFrontmatter?, body: String) {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard trimmed.hasPrefix("---") else { return (nil, text) }

    // Find the closing ---
    let afterOpening = trimmed.index(trimmed.startIndex, offsetBy: 3)
    let rest = trimmed[afterOpening...]
    guard let closingRange = rest.range(of: "\n---") else { return (nil, text) }

    let yamlContent = String(rest[rest.startIndex..<closingRange.lowerBound])
    let bodyStart = closingRange.upperBound
    let body = String(rest[bodyStart...]).trimmingCharacters(in: .newlines)

    // Simple line-by-line YAML parsing for known keys
    var fm = MarkdownFrontmatter()
    var inMetadata = false
    var inVellum = false

    for line in yamlContent.components(separatedBy: "\n") {
        let stripped = line.trimmingCharacters(in: .whitespaces)
        if stripped.isEmpty { continue }

        let indent = line.prefix(while: { $0 == " " }).count

        if indent == 0 {
            inMetadata = stripped == "metadata:"
            inVellum = false
            if !inMetadata {
                if let value = extractYAMLValue(stripped, key: "name") {
                    fm.name = value
                } else if let value = extractYAMLValue(stripped, key: "description") {
                    fm.description = value
                } else if let value = extractYAMLValue(stripped, key: "compatibility") {
                    fm.compatibility = value
                }
            }
        } else if inMetadata && indent >= 2 {
            if stripped == "vellum:" {
                inVellum = true
            } else if let value = extractYAMLValue(stripped, key: "emoji") {
                fm.emoji = value
            } else if inVellum, let value = extractYAMLValue(stripped, key: "display-name") {
                fm.displayName = value
            }
        }
    }

    // Only return frontmatter if we found at least a name or display-name
    if fm.name != nil || fm.displayName != nil {
        return (fm, body)
    }
    return (nil, text)
}

/// Extracts a YAML value for a given key from a "key: value" line, stripping quotes.
private func extractYAMLValue(_ line: String, key: String) -> String? {
    let prefix = "\(key):"
    guard line.hasPrefix(prefix) else { return nil }
    var value = String(line.dropFirst(prefix.count)).trimmingCharacters(in: .whitespaces)
    // Strip surrounding quotes
    if (value.hasPrefix("\"") && value.hasSuffix("\"")) || (value.hasPrefix("'") && value.hasSuffix("'")) {
        value = String(value.dropFirst().dropLast())
    }
    return value.isEmpty ? nil : value
}

// MARK: - Block-level data model

/// Represents a parsed block-level Markdown element with a stable index-based identity.
private struct MarkdownBlock: Identifiable {
    let id: Int
    let kind: Kind

    enum Kind {
        case heading(level: Int, text: String)
        case paragraph(text: String)
        case codeBlock(language: String?, code: String)
        case unorderedList(items: [String])
        case orderedList(items: [(number: Int, text: String)])
        case horizontalRule
        case blockquote(text: String)
        case blank
    }
}

// MARK: - Markdown parser

/// Parses a raw Markdown string into an array of block-level elements.
private func parseMarkdown(_ text: String) -> [MarkdownBlock] {
    let lines = text.components(separatedBy: "\n")
    var kinds: [MarkdownBlock.Kind] = []

    var inCodeFence = false
    var codeFenceLanguage: String?
    var codeLines: [String] = []

    var blockquoteLines: [String] = []
    var unorderedListItems: [String] = []
    var orderedListItems: [(number: Int, text: String)] = []
    var paragraphLines: [String] = []

    func flushBlockquote() {
        guard !blockquoteLines.isEmpty else { return }
        kinds.append(.blockquote(text: blockquoteLines.joined(separator: "\n")))
        blockquoteLines.removeAll()
    }

    func flushUnorderedList() {
        guard !unorderedListItems.isEmpty else { return }
        kinds.append(.unorderedList(items: unorderedListItems))
        unorderedListItems.removeAll()
    }

    func flushOrderedList() {
        guard !orderedListItems.isEmpty else { return }
        kinds.append(.orderedList(items: orderedListItems))
        orderedListItems.removeAll()
    }

    func flushParagraph() {
        guard !paragraphLines.isEmpty else { return }
        kinds.append(.paragraph(text: paragraphLines.joined(separator: " ")))
        paragraphLines.removeAll()
    }

    for line in lines {
        // --- Code fence handling ---
        if line.hasPrefix("```") {
            if inCodeFence {
                // Closing fence
                kinds.append(.codeBlock(language: codeFenceLanguage, code: codeLines.joined(separator: "\n")))
                codeLines.removeAll()
                codeFenceLanguage = nil
                inCodeFence = false
            } else {
                // Opening fence: flush any pending content
                flushParagraph()
                flushBlockquote()
                flushUnorderedList()
                flushOrderedList()

                let langPart = String(line.dropFirst(3)).trimmingCharacters(in: .whitespaces)
                codeFenceLanguage = langPart.isEmpty ? nil : langPart
                inCodeFence = true
            }
            continue
        }

        if inCodeFence {
            codeLines.append(line)
            continue
        }

        let trimmed = line.trimmingCharacters(in: .whitespaces)

        // --- Empty line ---
        if trimmed.isEmpty {
            flushParagraph()
            flushBlockquote()
            flushUnorderedList()
            flushOrderedList()
            kinds.append(.blank)
            continue
        }

        // --- Heading ---
        if let headingMatch = trimmed.range(of: #"^#{1,6}\s"#, options: .regularExpression) {
            flushParagraph()
            flushBlockquote()
            flushUnorderedList()
            flushOrderedList()

            let hashes = trimmed[trimmed.startIndex..<headingMatch.upperBound]
                .trimmingCharacters(in: .whitespaces)
            let level = hashes.count
            let headingText = String(trimmed.dropFirst(level)).trimmingCharacters(in: .whitespaces)
            kinds.append(.heading(level: level, text: headingText))
            continue
        }

        // --- Horizontal rule ---
        if trimmed == "---" || trimmed == "***" || trimmed == "___" {
            flushParagraph()
            flushBlockquote()
            flushUnorderedList()
            flushOrderedList()
            kinds.append(.horizontalRule)
            continue
        }

        // --- Blockquote ---
        if trimmed.range(of: #"^>\s?"#, options: .regularExpression) != nil {
            flushParagraph()
            flushUnorderedList()
            flushOrderedList()

            let quoteText = String(trimmed.dropFirst(1)).trimmingCharacters(in: .init(charactersIn: " "))
            blockquoteLines.append(quoteText)
            continue
        }

        // --- Unordered list ---
        if trimmed.range(of: #"^[-*+]\s"#, options: .regularExpression) != nil {
            flushParagraph()
            flushBlockquote()
            flushOrderedList()

            let itemText = String(trimmed.dropFirst(2))
            unorderedListItems.append(itemText)
            continue
        }

        // --- Ordered list ---
        if let olMatch = trimmed.range(of: #"^\d+\.\s"#, options: .regularExpression) {
            flushParagraph()
            flushBlockquote()
            flushUnorderedList()

            let prefix = String(trimmed[olMatch])
            let numberStr = prefix.trimmingCharacters(in: .init(charactersIn: ". "))
            let number = Int(numberStr) ?? 1
            let itemText = String(trimmed[olMatch.upperBound...])
            orderedListItems.append((number: number, text: itemText))
            continue
        }

        // --- Paragraph (default) ---
        flushBlockquote()
        flushUnorderedList()
        flushOrderedList()
        paragraphLines.append(trimmed)
    }

    // Flush remaining pending content
    if inCodeFence {
        // Unclosed code fence: emit whatever was accumulated
        kinds.append(.codeBlock(language: codeFenceLanguage, code: codeLines.joined(separator: "\n")))
    }
    flushParagraph()
    flushBlockquote()
    flushUnorderedList()
    flushOrderedList()

    return kinds.enumerated().map { MarkdownBlock(id: $0.offset, kind: $0.element) }
}

// MARK: - Inline Markdown rendering

/// Represents a segment of inline-formatted text.
private enum InlineSegment {
    case plain(String)
    case bold(String)
    case italic(String)
    case code(String)
    case link(text: String, url: String)
}

/// Parses inline Markdown formatting into segments.
private func parseInlineSegments(_ text: String) -> [InlineSegment] {
    var segments: [InlineSegment] = []
    var remaining = text[text.startIndex...]

    // Combined pattern for inline formatting:
    // bold (**...**), italic (*...*), inline code (`...`), links ([text](url))
    let pattern = #"\*\*(.+?)\*\*|\*(.+?)\*|`(.+?)`|\[(.+?)\]\((.+?)\)"#
    guard let regex = try? NSRegularExpression(pattern: pattern) else {
        return [.plain(text)]
    }

    while !remaining.isEmpty {
        let nsRange = NSRange(remaining.startIndex..<remaining.endIndex, in: text)
        guard let match = regex.firstMatch(in: text, range: nsRange) else {
            // No more matches — rest is plain text
            if !remaining.isEmpty {
                segments.append(.plain(String(remaining)))
            }
            break
        }

        let matchRange = Range(match.range, in: text)!

        // Plain text before this match
        if remaining.startIndex < matchRange.lowerBound {
            segments.append(.plain(String(text[remaining.startIndex..<matchRange.lowerBound])))
        }

        if let boldRange = Range(match.range(at: 1), in: text) {
            segments.append(.bold(String(text[boldRange])))
        } else if let italicRange = Range(match.range(at: 2), in: text) {
            segments.append(.italic(String(text[italicRange])))
        } else if let codeRange = Range(match.range(at: 3), in: text) {
            segments.append(.code(String(text[codeRange])))
        } else if let linkTextRange = Range(match.range(at: 4), in: text),
                  let linkUrlRange = Range(match.range(at: 5), in: text) {
            segments.append(.link(
                text: String(text[linkTextRange]),
                url: String(text[linkUrlRange])
            ))
        }

        remaining = text[matchRange.upperBound...]
    }

    return segments
}

/// Renders inline Markdown formatting as a composed SwiftUI `Text` view.
private func renderInlineMarkdown(_ text: String) -> Text {
    let segments = parseInlineSegments(text)
    guard !segments.isEmpty else { return Text("") }

    var result = Text("")
    for segment in segments {
        switch segment {
        case .plain(let content):
            result = result + Text(content)
        case .bold(let content):
            result = result + Text(content).bold()
        case .italic(let content):
            result = result + Text(content).italic()
        case .code(let content):
            result = result + Text(content)
                .font(VFont.bodyMediumDefault)
                .foregroundStyle(VColor.systemPositiveStrong)
        case .link(let linkText, let linkUrl):
            if let url = URL(string: linkUrl) {
                var attributed = AttributedString(linkText)
                attributed.link = url
                attributed.underlineStyle = .single
                result = result + Text(attributed)
            } else {
                result = result + Text(linkText)
                    .foregroundStyle(VColor.primaryBase)
                    .underline()
            }
        }
    }

    return result
}

// MARK: - MarkdownPreviewView

/// Renders Markdown content as styled, selectable SwiftUI views.
///
/// Parses block-level Markdown (headings, code blocks, lists, blockquotes, etc.)
/// and inline formatting (bold, italic, code, links) into native SwiftUI views
/// styled with design system tokens.
struct MarkdownPreviewView: View {
    let content: String

    @State private var blocks: [MarkdownBlock] = []
    @State private var frontmatter: MarkdownFrontmatter?

    var body: some View {
        ScrollView(.vertical) {
            LazyVStack(alignment: .leading, spacing: VSpacing.sm) {
                if let fm = frontmatter {
                    frontmatterHeader(fm)
                    if !blocks.isEmpty {
                        Divider()
                            .padding(.vertical, VSpacing.xs)
                    }
                }
                ForEach(blocks) { block in
                    blockView(for: block)
                }
            }
            .padding(VSpacing.lg)
        }
        .tint(VColor.primaryBase)
        .textSelection(.enabled)
        .task(id: content) {
            let (fm, body) = parseFrontmatter(content)
            frontmatter = fm
            blocks = parseMarkdown(body)
        }
    }

    @ViewBuilder
    private func frontmatterHeader(_ fm: MarkdownFrontmatter) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            HStack(spacing: VSpacing.sm) {
                if let emoji = fm.emoji {
                    Text(emoji)
                        .font(VFont.cardEmoji)
                }
                Text(fm.displayName ?? fm.name ?? "")
                    .font(VFont.titleLarge)
                    .foregroundStyle(VColor.contentEmphasized)
            }
            if let description = fm.description {
                Text(description)
                    .font(VFont.bodyMediumLighter)
                    .foregroundStyle(VColor.contentSecondary)
            }
            if let compatibility = fm.compatibility {
                Text(compatibility)
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentTertiary)
            }
        }
    }

    @ViewBuilder
    private func blockView(for block: MarkdownBlock) -> some View {
        switch block.kind {
        case .heading(let level, let text):
            headingView(level: level, text: text)
        case .paragraph(let text):
            renderInlineMarkdown(text)
                .font(VFont.bodyMediumLighter)
                .foregroundStyle(VColor.contentDefault)
        case .codeBlock(_, let code):
            codeBlockView(code: code)
        case .unorderedList(let items):
            unorderedListView(items: items)
        case .orderedList(let items):
            orderedListView(items: items)
        case .horizontalRule:
            Divider()
                .padding(.vertical, VSpacing.sm)
        case .blockquote(let text):
            blockquoteView(text: text)
        case .blank:
            Spacer()
                .frame(height: VSpacing.sm)
        }
    }

    @ViewBuilder
    private func headingView(level: Int, text: String) -> some View {
        switch level {
        case 1:
            renderInlineMarkdown(text)
                .font(VFont.titleLarge)
                .foregroundStyle(VColor.contentEmphasized)
                .padding(.bottom, VSpacing.xs)
        case 2:
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                renderInlineMarkdown(text)
                    .font(VFont.titleMedium)
                    .foregroundStyle(VColor.contentEmphasized)
                Divider()
            }
        case 3:
            renderInlineMarkdown(text)
                .font(VFont.bodySmallEmphasised)
                .foregroundStyle(VColor.contentEmphasized)
        default:
            renderInlineMarkdown(text)
                .font(VFont.bodyMediumDefault)
                .foregroundStyle(VColor.contentEmphasized)
        }
    }

    private func codeBlockView(code: String) -> some View {
        ScrollView(.horizontal) {
            Text(code)
                .font(VFont.bodyMediumDefault)
                .foregroundStyle(VColor.contentDefault)
                .textSelection(.enabled)
                .fixedSize(horizontal: true, vertical: false)
        }
        .padding(VSpacing.md)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: VRadius.md)
                .fill(VColor.surfaceActive)
        )
    }

    private func unorderedListView(items: [String]) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.xs) {
            ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                HStack(alignment: .top, spacing: VSpacing.xs) {
                    Text("\u{2022}")
                        .foregroundStyle(VColor.contentTertiary)
                        .accessibilityHidden(true)
                    renderInlineMarkdown(item)
                        .font(VFont.bodyMediumLighter)
                        .foregroundStyle(VColor.contentDefault)
                }
            }
        }
        .padding(.leading, VSpacing.lg)
    }

    private func orderedListView(items: [(number: Int, text: String)]) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.xs) {
            ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                HStack(alignment: .top, spacing: VSpacing.xs) {
                    Text("\(item.number).")
                        .foregroundStyle(VColor.contentTertiary)
                    renderInlineMarkdown(item.text)
                        .font(VFont.bodyMediumLighter)
                        .foregroundStyle(VColor.contentDefault)
                }
            }
        }
        .padding(.leading, VSpacing.lg)
    }

    private func blockquoteView(text: String) -> some View {
        HStack(alignment: .top, spacing: VSpacing.sm) {
            Rectangle()
                .fill(VColor.primaryBase)
                .frame(width: 3)
                .accessibilityHidden(true)
            renderInlineMarkdown(text)
                .font(VFont.bodyMediumLighter)
                .foregroundStyle(VColor.contentSecondary)
        }
        .padding(.leading, VSpacing.lg)
    }
}
