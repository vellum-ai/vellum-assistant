import SwiftUI
import VellumAssistantShared

/// Reusable view that renders parsed `MarkdownSegment` arrays.
/// Used by both ChatBubble and SubagentDetailPanel.
struct MarkdownSegmentView: View {
    let segments: [MarkdownSegment]
    var maxContentWidth: CGFloat? = 520

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            ForEach(Array(segments.enumerated()), id: \.offset) { _, segment in
                switch segment {
                case .text(let text):
                    let options = AttributedString.MarkdownParsingOptions(
                        interpretedSyntax: .inlineOnlyPreservingWhitespace
                    )
                    let attributed = (try? AttributedString(markdown: text, options: options))
                        ?? AttributedString(text)
                    Text(attributed)
                        .font(.system(size: 13))
                        .foregroundColor(VColor.textPrimary)
                        .tint(VColor.accent)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: maxContentWidth ?? .infinity, alignment: .leading)

                case .heading(let level, let headingText):
                    let font: Font = switch level {
                    case 1: .system(size: 20, weight: .bold)
                    case 2: .system(size: 17, weight: .semibold)
                    case 3: .system(size: 14, weight: .semibold)
                    default: .system(size: 13, weight: .semibold)
                    }
                    Text(headingText)
                        .font(font)
                        .foregroundColor(VColor.textPrimary)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: maxContentWidth ?? .infinity, alignment: .leading)
                        .padding(.top, level == 1 ? VSpacing.xs : 0)

                case .codeBlock(let language, let code):
                    VStack(alignment: .leading, spacing: 0) {
                        if let language, !language.isEmpty {
                            Text(language)
                                .font(.system(size: 11, weight: .medium))
                                .foregroundColor(VColor.textMuted)
                                .padding(.horizontal, VSpacing.sm)
                                .padding(.top, VSpacing.xs)
                        }
                        ScrollView(.horizontal, showsIndicators: false) {
                            Text(code)
                                .font(VFont.mono)
                                .foregroundColor(VColor.textPrimary)
                                .textSelection(.enabled)
                                .fixedSize(horizontal: true, vertical: true)
                                .padding(VSpacing.sm)
                        }
                    }
                    .frame(maxWidth: maxContentWidth ?? .infinity, alignment: .leading)
                    .background(VColor.backgroundSubtle)
                    .clipShape(RoundedRectangle(cornerRadius: VRadius.md))

                case .table(let headers, let rows):
                    MarkdownTableView(headers: headers, rows: rows, maxWidth: maxContentWidth ?? .infinity)

                case .image(let alt, let url):
                    AnimatedImageView(urlString: url)
                        .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
                        .accessibilityLabel(alt.isEmpty ? "Image" : alt)

                case .list(let items):
                    VStack(alignment: .leading, spacing: VSpacing.xxs) {
                        ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                            let prefix = item.ordered ? "\(item.number). " : "\u{2022} "
                            let indentLevel = item.indent / 2
                            HStack(alignment: .top, spacing: 0) {
                                Text(prefix)
                                    .font(.system(size: 13))
                                    .foregroundColor(VColor.textSecondary)
                                let options = AttributedString.MarkdownParsingOptions(
                                    interpretedSyntax: .inlineOnlyPreservingWhitespace
                                )
                                let attributed = (try? AttributedString(markdown: item.text, options: options))
                                    ?? AttributedString(item.text)
                                Text(attributed)
                                    .font(.system(size: 13))
                                    .foregroundColor(VColor.textPrimary)
                                    .tint(VColor.accent)
                                    .textSelection(.enabled)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                            .padding(.leading, CGFloat(indentLevel) * 16)
                        }
                    }
                    .frame(maxWidth: maxContentWidth ?? .infinity, alignment: .leading)

                case .horizontalRule:
                    Rectangle()
                        .fill(VColor.surfaceBorder)
                        .frame(height: 1)
                        .frame(maxWidth: maxContentWidth ?? .infinity)
                        .padding(.vertical, VSpacing.xs)
                }
            }
        }
    }
}
