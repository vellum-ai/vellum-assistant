import SwiftUI

// MARK: - MarkdownBlock

private enum MarkdownBlock {
    case heading(level: Int, text: String)
    case paragraph(text: String)
    case codeBlock(lang: String, code: String)
    case list(ordered: Bool, items: [String])
    case horizontalRule
}

// MARK: - MarkdownParser

private enum MarkdownParser {
    static func parse(_ text: String) -> [MarkdownBlock] {
        let lines = text.components(separatedBy: "\n")
        var blocks: [MarkdownBlock] = []
        var i = 0

        while i < lines.count {
            let line = lines[i]

            // Fenced code block
            if line.hasPrefix("```") {
                let lang = String(line.dropFirst(3)).trimmingCharacters(in: .whitespaces)
                var codeLines: [String] = []
                i += 1
                while i < lines.count && !lines[i].hasPrefix("```") {
                    codeLines.append(lines[i])
                    i += 1
                }
                // Skip closing ```
                if i < lines.count { i += 1 }
                blocks.append(.codeBlock(lang: lang, code: codeLines.joined(separator: "\n")))
                continue
            }

            // Horizontal rule
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed == "---" || trimmed == "***" || trimmed == "___" {
                blocks.append(.horizontalRule)
                i += 1
                continue
            }

            // Heading
            if line.hasPrefix("#") {
                var level = 0
                var rest = line
                while rest.hasPrefix("#") {
                    level += 1
                    rest = String(rest.dropFirst())
                }
                if rest.hasPrefix(" ") {
                    rest = String(rest.dropFirst())
                }
                blocks.append(.heading(level: level, text: rest))
                i += 1
                continue
            }

            // Unordered list
            if trimmed.hasPrefix("- ") || trimmed.hasPrefix("* ") || trimmed.hasPrefix("+ ") {
                var items: [String] = []
                while i < lines.count {
                    let t = lines[i].trimmingCharacters(in: .whitespaces)
                    if t.hasPrefix("- ") || t.hasPrefix("* ") || t.hasPrefix("+ ") {
                        items.append(String(t.dropFirst(2)))
                        i += 1
                    } else {
                        break
                    }
                }
                blocks.append(.list(ordered: false, items: items))
                continue
            }

            // Ordered list
            if let match = trimmed.range(of: #"^\d+\.\s"#, options: .regularExpression) {
                var items: [String] = []
                while i < lines.count {
                    let t = lines[i].trimmingCharacters(in: .whitespaces)
                    if t.range(of: #"^\d+\.\s"#, options: .regularExpression) != nil {
                        // Remove "1. " prefix
                        if let spaceIdx = t.firstIndex(of: " ") {
                            items.append(String(t[t.index(after: spaceIdx)...]))
                        }
                        i += 1
                    } else {
                        break
                    }
                }
                _ = match  // silence unused warning
                blocks.append(.list(ordered: true, items: items))
                continue
            }

            // Empty line — separate paragraphs
            if trimmed.isEmpty {
                i += 1
                continue
            }

            // Paragraph: accumulate consecutive non-blank lines that don't start block elements
            var paraLines: [String] = []
            while i < lines.count {
                let l = lines[i]
                let t = l.trimmingCharacters(in: .whitespaces)
                if t.isEmpty { break }
                if l.hasPrefix("#") || l.hasPrefix("```") ||
                   t.hasPrefix("- ") || t.hasPrefix("* ") || t.hasPrefix("+ ") ||
                   t == "---" || t == "***" || t == "___" { break }
                if t.range(of: #"^\d+\.\s"#, options: .regularExpression) != nil { break }
                paraLines.append(l)
                i += 1
            }
            if !paraLines.isEmpty {
                blocks.append(.paragraph(text: paraLines.joined(separator: "\n")))
            }
        }

        return blocks
    }
}

// MARK: - MarkdownRenderer

/// Renders markdown text as a structured SwiftUI view, with support for
/// code blocks, headings, lists, horizontal rules, and inline formatting.
public struct MarkdownRenderer: View {
    public let text: String

    public init(text: String) {
        self.text = text
    }

    public var body: some View {
        let blocks = MarkdownParser.parse(text)
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                blockView(for: block)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private func blockView(for block: MarkdownBlock) -> some View {
        switch block {
        case .heading(let level, let text):
            Text(inlineMarkdown(text))
                .font(level <= 2 ? VFont.headline : VFont.bodyMedium)
                .foregroundColor(VColor.textPrimary)
                .frame(maxWidth: .infinity, alignment: .leading)

        case .paragraph(let text):
            Text(inlineMarkdown(text))
                .font(VFont.body)
                .foregroundColor(VColor.textPrimary)
                .tint(VColor.accent)
                .frame(maxWidth: .infinity, alignment: .leading)
                .textSelection(.enabled)

        case .codeBlock(let lang, let code):
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                if !lang.isEmpty {
                    Text(lang)
                        .font(VFont.monoSmall)
                        .foregroundColor(VColor.textMuted)
                        .padding(.horizontal, VSpacing.sm)
                        .padding(.top, VSpacing.xs)
                }
                Text(code)
                    .font(VFont.mono)
                    .foregroundColor(VColor.textPrimary)
                    .padding(VSpacing.sm)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .textSelection(.enabled)
            }
            .background(VColor.backgroundSubtle)
            .clipShape(RoundedRectangle(cornerRadius: VRadius.md))

        case .list(let ordered, let items):
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                    HStack(alignment: .top, spacing: VSpacing.xs) {
                        Text(ordered ? "\(index + 1)." : "•")
                            .font(VFont.body)
                            .foregroundColor(VColor.textSecondary)
                            .frame(minWidth: ordered ? 24 : 12, alignment: .leading)
                        Text(inlineMarkdown(item))
                            .font(VFont.body)
                            .foregroundColor(VColor.textPrimary)
                            .tint(VColor.accent)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .textSelection(.enabled)
                    }
                }
            }

        case .horizontalRule:
            Rectangle()
                .fill(VColor.surfaceBorder)
                .frame(maxWidth: .infinity)
                .frame(height: 1)
        }
    }

    /// Parse inline markdown (bold, italic, code) using AttributedString.
    private func inlineMarkdown(_ text: String) -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(
            interpretedSyntax: .inlineOnlyPreservingWhitespace
        )
        return (try? AttributedString(markdown: text, options: options))
            ?? AttributedString(text)
    }
}

#Preview("Markdown Renderer") {
    ScrollView {
        MarkdownRenderer(text: """
        # Heading 1

        ## Heading 2

        ### Heading 3

        A paragraph with **bold**, _italic_, and `inline code`.

        ```swift
        let greeting = "Hello, world!"
        print(greeting)
        ```

        - Item one
        - Item two
        - Item three

        1. First step
        2. Second step
        3. Third step

        ---

        Another paragraph after a rule.
        """)
        .padding()
    }
    .background(VColor.background)
}
