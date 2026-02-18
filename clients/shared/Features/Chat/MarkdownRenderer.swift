import SwiftUI

// MARK: - MarkdownRenderer

/// Renders markdown text as a structured SwiftUI view, with support for
/// code blocks, headings, lists, tables, images, horizontal rules, and inline formatting.
public struct MarkdownRenderer: View {
    public let text: String

    public init(text: String) {
        self.text = text
    }

    public var body: some View {
        let blocks = MarkdownBlockParser.parse(text)
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

        case .text(let text):
            Text(inlineMarkdown(text))
                .font(VFont.body)
                .foregroundColor(VColor.textPrimary)
                .tint(VColor.accent)
                .frame(maxWidth: .infinity, alignment: .leading)
                .textSelection(.enabled)

        case .codeBlock(let lang, let code):
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                if let lang, !lang.isEmpty {
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

        case .list(let items):
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                    let prefix = item.ordered ? "\(item.number)." : "\u{2022}"
                    let indentLevel = item.indent / 2
                    HStack(alignment: .top, spacing: VSpacing.xs) {
                        Text(prefix)
                            .font(VFont.body)
                            .foregroundColor(VColor.textSecondary)
                            .frame(minWidth: item.ordered ? 24 : 12, alignment: .leading)
                        Text(inlineMarkdown(item.text))
                            .font(VFont.body)
                            .foregroundColor(VColor.textPrimary)
                            .tint(VColor.accent)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .textSelection(.enabled)
                    }
                    .padding(.leading, CGFloat(indentLevel) * 16)
                }
            }

        case .table(let headers, let rows):
            VStack(alignment: .leading, spacing: 0) {
                // Header row
                HStack(spacing: 0) {
                    ForEach(Array(headers.enumerated()), id: \.offset) { _, header in
                        Text(inlineMarkdown(header))
                            .font(VFont.bodyMedium)
                            .foregroundColor(VColor.textPrimary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(VSpacing.xs)
                    }
                }
                .background(VColor.backgroundSubtle)

                Rectangle()
                    .fill(VColor.surfaceBorder)
                    .frame(height: 1)

                // Data rows
                ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                    HStack(spacing: 0) {
                        ForEach(Array(row.enumerated()), id: \.offset) { _, cell in
                            Text(inlineMarkdown(cell))
                                .font(VFont.body)
                                .foregroundColor(VColor.textPrimary)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(VSpacing.xs)
                        }
                    }
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
            .overlay(
                RoundedRectangle(cornerRadius: VRadius.md)
                    .stroke(VColor.surfaceBorder, lineWidth: 1)
            )

        case .image(let alt, let url):
            if let imageURL = URL(string: url) {
                AsyncImage(url: imageURL) { phase in
                    switch phase {
                    case .success(let image):
                        image
                            .resizable()
                            .aspectRatio(contentMode: .fit)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
                    case .failure:
                        Text(alt.isEmpty ? "Image failed to load" : alt)
                            .font(VFont.body)
                            .foregroundColor(VColor.textMuted)
                            .italic()
                    default:
                        ProgressView()
                            .frame(height: 100)
                    }
                }
                .accessibilityLabel(alt)
            } else {
                Text(alt.isEmpty ? "Invalid image URL" : alt)
                    .font(VFont.body)
                    .foregroundColor(VColor.textMuted)
                    .italic()
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

        | Name | Value |
        | ---- | ----- |
        | Foo  | 42    |
        | Bar  | 99    |

        ---

        Another paragraph after a rule.
        """)
        .padding()
    }
    .background(VColor.background)
}
