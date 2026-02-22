import AppKit
import SwiftUI
import VellumAssistantShared

/// Reusable view that renders parsed `MarkdownSegment` arrays.
/// Groups consecutive text-selectable segments (text, headings, lists) into
/// unified Text views so that text selection can span across paragraphs.
struct MarkdownSegmentView: View {
    let segments: [MarkdownSegment]
    var maxContentWidth: CGFloat? = 520
    var textColor: Color = VColor.textPrimary
    var secondaryTextColor: Color = VColor.textSecondary
    var mutedTextColor: Color = VColor.textMuted
    var tintColor: Color = VColor.accent
    var codeBackgroundColor: Color = VColor.backgroundSubtle
    var hrColor: Color = VColor.surfaceBorder

    var body: some View {
        let groups = groupedSegments
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            ForEach(Array(groups.enumerated()), id: \.offset) { _, group in
                switch group {
                case .selectableRun(let runSegments):
                    let attributed = buildCombinedAttributedString(from: runSegments)
                    Text(attributed)
                        .font(.system(size: 13))
                        .foregroundColor(textColor)
                        .tint(tintColor)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: maxContentWidth ?? .infinity, alignment: .leading)

                case .codeBlock(let language, let code):
                    VStack(alignment: .leading, spacing: 0) {
                        if let language, !language.isEmpty {
                            Text(language)
                                .font(.system(size: 11, weight: .medium))
                                .foregroundColor(mutedTextColor)
                                .padding(.horizontal, VSpacing.sm)
                                .padding(.top, VSpacing.xs)
                        }
                        ScrollView(.horizontal, showsIndicators: false) {
                            Text(code)
                                .font(VFont.mono)
                                .foregroundColor(textColor)
                                .textSelection(.enabled)
                                .fixedSize(horizontal: true, vertical: true)
                                .padding(VSpacing.sm)
                        }
                    }
                    .frame(maxWidth: maxContentWidth ?? .infinity, alignment: .leading)
                    .background(codeBackgroundColor)
                    .clipShape(RoundedRectangle(cornerRadius: VRadius.md))

                case .table(let headers, let rows):
                    MarkdownTableView(headers: headers, rows: rows, maxWidth: maxContentWidth ?? .infinity)

                case .image(let alt, let url):
                    AnimatedImageView(urlString: url)
                        .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
                        .accessibilityLabel(alt.isEmpty ? "Image" : alt)

                case .horizontalRule:
                    Rectangle()
                        .fill(hrColor)
                        .frame(height: 1)
                        .frame(maxWidth: maxContentWidth ?? .infinity)
                        .padding(.vertical, VSpacing.xs)
                }
            }
        }
    }

    // MARK: - Segment Grouping

    /// Groups of segments for unified text selection rendering.
    private enum SegmentGroup {
        /// Consecutive text-selectable segments combined for cross-paragraph selection.
        case selectableRun([MarkdownSegment])
        case codeBlock(language: String?, code: String)
        case table(headers: [String], rows: [[String]])
        case image(alt: String, url: String)
        case horizontalRule
    }

    /// Groups consecutive text-selectable segments together so they render
    /// as a single Text view, enabling cross-paragraph text selection.
    private var groupedSegments: [SegmentGroup] {
        var groups: [SegmentGroup] = []
        var currentRun: [MarkdownSegment] = []

        func flushRun() {
            if !currentRun.isEmpty {
                groups.append(.selectableRun(currentRun))
                currentRun = []
            }
        }

        for segment in segments {
            switch segment {
            case .text, .heading, .list:
                currentRun.append(segment)
            case .codeBlock(let language, let code):
                flushRun()
                groups.append(.codeBlock(language: language, code: code))
            case .table(let headers, let rows):
                flushRun()
                groups.append(.table(headers: headers, rows: rows))
            case .image(let alt, let url):
                flushRun()
                groups.append(.image(alt: alt, url: url))
            case .horizontalRule:
                flushRun()
                groups.append(.horizontalRule)
            }
        }

        flushRun()
        return groups
    }

    // MARK: - Combined AttributedString

    /// Builds a single AttributedString from consecutive text-selectable segments,
    /// allowing text selection to span across paragraphs, headings, and list items.
    private func buildCombinedAttributedString(from segments: [MarkdownSegment]) -> AttributedString {
        let mdOptions = AttributedString.MarkdownParsingOptions(
            interpretedSyntax: .inlineOnlyPreservingWhitespace
        )
        var result = AttributedString()

        for (index, segment) in segments.enumerated() {
            if index > 0 {
                result += AttributedString("\n\n")
            }

            switch segment {
            case .text(let text):
                let attributed = (try? AttributedString(markdown: text, options: mdOptions))
                    ?? AttributedString(text)
                result += attributed

            case .heading(let level, let headingText):
                var heading = AttributedString(headingText)
                heading.font = switch level {
                case 1: .system(size: 20, weight: .bold)
                case 2: .system(size: 17, weight: .semibold)
                case 3: .system(size: 14, weight: .semibold)
                default: .system(size: 13, weight: .semibold)
                }
                result += heading

            case .list(let items):
                let indentStep: CGFloat = 16
                let font = NSFont.systemFont(ofSize: 13)

                for (itemIndex, item) in items.enumerated() {
                    if itemIndex > 0 {
                        result += AttributedString("\n")
                    }

                    let indentLevel = CGFloat(item.indent / 2)
                    let leftMargin = indentLevel * indentStep
                    let prefix = item.ordered ? "\(item.number).\t" : "\u{2022}\t"

                    // Measure the prefix width to set the tab stop / hanging indent
                    let prefixForMeasure = item.ordered ? "\(item.number). " : "\u{2022} "
                    let prefixSize = (prefixForMeasure as NSString).size(withAttributes: [.font: font])
                    let textColumn = leftMargin + prefixSize.width

                    // Build paragraph style with hanging indent so wrapped lines
                    // align with the text column rather than the bullet/number.
                    let paraStyle = NSMutableParagraphStyle()
                    paraStyle.firstLineHeadIndent = leftMargin
                    paraStyle.headIndent = textColumn
                    paraStyle.tabStops = [NSTextTab(textAlignment: .left, location: textColumn)]

                    var prefixAttr = AttributedString(prefix)
                    prefixAttr.foregroundColor = secondaryTextColor
                    prefixAttr.font = .system(size: 13)
                    prefixAttr.paragraphStyle = paraStyle
                    result += prefixAttr

                    var itemAttr = (try? AttributedString(markdown: item.text, options: mdOptions))
                        ?? AttributedString(item.text)
                    itemAttr.paragraphStyle = paraStyle
                    result += itemAttr
                }

            default:
                break
            }
        }

        return result
    }
}
