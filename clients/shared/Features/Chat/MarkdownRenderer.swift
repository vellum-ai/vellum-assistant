import SwiftUI
#if os(macOS)
import AppKit
#elseif os(iOS)
import UIKit
#endif

// MARK: - CodeBlockView

/// Fenced code block with a copy-to-clipboard button.
private struct CodeBlockView: View {
    let lang: String
    let code: String

    @State private var showCopied = false

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.xs) {
            HStack(spacing: VSpacing.sm) {
                if !lang.isEmpty {
                    Text(lang)
                        .font(VFont.bodySmallDefault)
                        .foregroundStyle(VColor.contentTertiary)
                }
                Spacer()
                Button(action: copyCode) {
                    HStack(spacing: VSpacing.xxs) {
                        VIconView(showCopied ? .check : .copy, size: 11)
                        if showCopied {
                            Text("Copied")
                                .font(VFont.bodySmallDefault)
                        }
                    }
                    .foregroundStyle(showCopied ? VColor.systemPositiveStrong : VColor.contentTertiary)
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, VSpacing.sm)
            .padding(.top, VSpacing.xs)

            Text(code)
                .font(VFont.bodyMediumDefault)
                .foregroundStyle(VColor.contentDefault)
                .padding(VSpacing.sm)
                .textSelection(.enabled)
        }
        .background(VColor.surfaceActive)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
    }

    private func copyCode() {
        #if os(macOS)
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(code, forType: .string)
        #elseif os(iOS)
        UIPasteboard.general.string = code
        #endif
        showCopied = true
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            guard !Task.isCancelled else { return }
            showCopied = false
        }
    }
}

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

            // Empty line — skip if not inside paragraph accumulation
            if trimmed.isEmpty {
                i += 1
                continue
            }

            // Paragraph: accumulate text lines, including blank lines between paragraphs.
            // Only flush when a structural element (heading, code fence, list, HR) is encountered.
            var paraLines: [String] = []
            while i < lines.count {
                let l = lines[i]
                let t = l.trimmingCharacters(in: .whitespaces)

                // Structural elements always break paragraph accumulation
                if l.hasPrefix("#") || l.hasPrefix("```") ||
                   t.hasPrefix("- ") || t.hasPrefix("* ") || t.hasPrefix("+ ") ||
                   t == "---" || t == "***" || t == "___" { break }
                if t.range(of: #"^\d+\.\s"#, options: .regularExpression) != nil { break }

                // Empty line: include it to preserve \n\n between paragraphs,
                // but only if the next non-empty line is also text (not a structural element).
                if t.isEmpty {
                    // Peek ahead to see if there's more text after this blank line
                    var j = i + 1
                    while j < lines.count && lines[j].trimmingCharacters(in: .whitespaces).isEmpty {
                        j += 1
                    }
                    if j < lines.count {
                        let nextT = lines[j].trimmingCharacters(in: .whitespaces)
                        let nextL = lines[j]
                        if nextL.hasPrefix("#") || nextL.hasPrefix("```") ||
                           nextT.hasPrefix("- ") || nextT.hasPrefix("* ") || nextT.hasPrefix("+ ") ||
                           nextT == "---" || nextT == "***" || nextT == "___" ||
                           nextT.range(of: #"^\d+\.\s"#, options: .regularExpression) != nil {
                            break
                        }
                    } else {
                        // No more lines after the blank — stop
                        break
                    }
                    paraLines.append("")
                    i += 1
                    continue
                }

                paraLines.append(l)
                i += 1
            }
            if !paraLines.isEmpty {
                let text = paraLines.joined(separator: "\n")
                    .trimmingCharacters(in: .newlines)
                if !text.isEmpty {
                    blocks.append(.paragraph(text: text))
                }
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
    }

    @ViewBuilder
    private func blockView(for block: MarkdownBlock) -> some View {
        switch block {
        case .heading(let level, let text):
            Text(inlineMarkdown(text))
                .font(level == 1 ? VFont.titleSmall : level == 2 ? VFont.bodyLargeEmphasised : VFont.bodyMediumEmphasised)
                .foregroundStyle(VColor.contentDefault)

        case .paragraph(let text):
            Text(inlineMarkdown(text))
                .font(VFont.bodyMediumLighter)
                .foregroundStyle(VColor.contentDefault)
                .tint(VColor.primaryBase)
                .textSelection(.enabled)

        case .codeBlock(let lang, let code):
            CodeBlockView(lang: lang, code: code)

        case .list(let ordered, let items):
            VStack(alignment: .leading, spacing: VSpacing.sm) {
                ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                    HStack(alignment: .top, spacing: VSpacing.xs) {
                        Text(ordered ? "\(index + 1)." : "•")
                            .font(VFont.bodyMediumLighter)
                            .foregroundStyle(VColor.contentSecondary)
                            .frame(minWidth: ordered ? 24 : 12, alignment: .leading)
                        Text(inlineMarkdown(item))
                            .font(VFont.bodyMediumLighter)
                            .foregroundStyle(VColor.contentDefault)
                            .tint(VColor.primaryBase)
                            .textSelection(.enabled)
                    }
                }
            }

        case .horizontalRule:
            Rectangle()
                .fill(VColor.borderBase)
                .frame(height: 1)
        }
    }

    /// Parse inline markdown (bold, italic, code) using AttributedString.
    private func inlineMarkdown(_ text: String) -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(
            interpretedSyntax: .inlineOnlyPreservingWhitespace
        )
        var result = (try? AttributedString(markdown: text, options: options))
            ?? AttributedString(text)
        var codeRanges: [Range<AttributedString.Index>] = []
        for run in result.runs {
            if let intent = run.inlinePresentationIntent, intent.contains(.code) {
                codeRanges.append(run.range)
            }
        }
        for range in codeRanges.reversed() {
            result[range].foregroundColor = VColor.systemNegativeStrong
            result[range].backgroundColor = VColor.surfaceActive
            var trailing = AttributedString("\u{2009}")
            trailing.backgroundColor = VColor.surfaceActive
            result.insert(trailing, at: range.upperBound)
            var leading = AttributedString("\u{2009}")
            leading.backgroundColor = VColor.surfaceActive
            result.insert(leading, at: range.lowerBound)
        }
        return result
    }
}

