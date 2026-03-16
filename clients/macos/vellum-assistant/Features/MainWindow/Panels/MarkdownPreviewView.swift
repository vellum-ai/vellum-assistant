import SwiftUI
import VellumAssistantShared

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
                .font(VFont.mono)
                .foregroundColor(VColor.systemPositiveStrong)
        case .link(let linkText, _):
            result = result + Text(linkText)
                .foregroundColor(VColor.primaryBase)
                .underline()
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

    var body: some View {
        ScrollView(.vertical) {
            LazyVStack(alignment: .leading, spacing: VSpacing.sm) {
                ForEach(blocks) { block in
                    blockView(for: block)
                }
            }
            .padding(VSpacing.lg)
        }
        .textSelection(.enabled)
        .task(id: content) {
            blocks = parseMarkdown(content)
        }
    }

    @ViewBuilder
    private func blockView(for block: MarkdownBlock) -> some View {
        switch block.kind {
        case .heading(let level, let text):
            headingView(level: level, text: text)
        case .paragraph(let text):
            renderInlineMarkdown(text)
                .font(VFont.body)
                .foregroundColor(VColor.contentDefault)
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
                .font(VFont.largeTitle)
                .foregroundColor(VColor.contentEmphasized)
                .padding(.bottom, VSpacing.xs)
        case 2:
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                renderInlineMarkdown(text)
                    .font(VFont.title)
                    .foregroundColor(VColor.contentEmphasized)
                Divider()
            }
        case 3:
            renderInlineMarkdown(text)
                .font(VFont.headline)
                .foregroundColor(VColor.contentEmphasized)
        default:
            renderInlineMarkdown(text)
                .font(VFont.bodyMedium)
                .foregroundColor(VColor.contentEmphasized)
        }
    }

    private func codeBlockView(code: String) -> some View {
        ScrollView(.horizontal) {
            Text(code)
                .font(VFont.mono)
                .foregroundColor(VColor.contentDefault)
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
                        .foregroundColor(VColor.contentTertiary)
                        .accessibilityHidden(true)
                    renderInlineMarkdown(item)
                        .font(VFont.body)
                        .foregroundColor(VColor.contentDefault)
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
                        .foregroundColor(VColor.contentTertiary)
                    renderInlineMarkdown(item.text)
                        .font(VFont.body)
                        .foregroundColor(VColor.contentDefault)
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
                .font(VFont.body)
                .foregroundColor(VColor.contentSecondary)
        }
        .padding(.leading, VSpacing.lg)
    }
}
