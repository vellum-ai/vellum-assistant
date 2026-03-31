@preconcurrency import AppKit
import os
import SwiftUI
import VellumAssistantShared

/// Reusable view that renders parsed `MarkdownSegment` arrays.
/// Groups consecutive text-selectable segments (text, headings, lists) into
/// unified Text views so that text selection can span across paragraphs.
struct MarkdownSegmentView: View, Equatable {
    let segments: [MarkdownSegment]
    var isStreaming: Bool = false
    var maxContentWidth: CGFloat? = VSpacing.chatBubbleMaxWidth
    var textColor: Color = VColor.contentDefault
    var secondaryTextColor: Color = VColor.contentSecondary
    var mutedTextColor: Color = VColor.contentTertiary
    var tintColor: Color = VColor.primaryBase
    var codeTextColor: Color = VColor.systemNegativeStrong
    var codeBackgroundColor: Color = VColor.surfaceActive
    var hrColor: Color = VColor.borderBase

    static func == (lhs: MarkdownSegmentView, rhs: MarkdownSegmentView) -> Bool {
        lhs.segments == rhs.segments
            && lhs.isStreaming == rhs.isStreaming
            && lhs.maxContentWidth == rhs.maxContentWidth
            && lhs.textColor == rhs.textColor
            && lhs.secondaryTextColor == rhs.secondaryTextColor
            && lhs.mutedTextColor == rhs.mutedTextColor
            && lhs.tintColor == rhs.tintColor
            && lhs.codeTextColor == rhs.codeTextColor
            && lhs.codeBackgroundColor == rhs.codeBackgroundColor
            && lhs.hrColor == rhs.hrColor
    }

    var body: some View {
        let groups = groupedSegments
        let scaledCodeLabelSize: CGFloat = 11
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            ForEach(Array(groups.enumerated()), id: \.offset) { _, group in
                switch group {
                case .selectableRun(let runSegments):
                    let nsAttr = SelectableTextView.cachedNSAttributedString(
                        from: runSegments,
                        textColor: NSColor(textColor),
                        secondaryTextColor: NSColor(secondaryTextColor),
                        codeTextColor: NSColor(codeTextColor),
                        codeBackgroundColor: NSColor(codeBackgroundColor)
                    )
                    SelectableTextView(
                        attributedString: nsAttr,
                        isSelectable: !isStreaming,
                        maxWidth: maxContentWidth
                    )

                case .heading(let level, let headingText):
                    let nsHeadingFont: NSFont = switch level {
                    case 1: VFont.nsHeading1
                    case 2: VFont.nsHeading2
                    default: VFont.nsHeading3
                    }
                    let nsHeadingAttr = NSAttributedString(
                        string: headingText,
                        attributes: [
                            .font: nsHeadingFont,
                            .foregroundColor: NSColor(textColor),
                        ]
                    )
                    SelectableTextView(
                        attributedString: nsHeadingAttr,
                        isSelectable: !isStreaming,
                        maxWidth: maxContentWidth
                    )
                    .padding(.top, level == 1 ? 4 : 2)

                case .codeBlock(let language, let code):
                    CodeBlockView(
                        language: language,
                        code: code,
                        scaledCodeLabelSize: scaledCodeLabelSize,
                        textColor: textColor,
                        mutedTextColor: mutedTextColor,
                        codeBackgroundColor: codeBackgroundColor,
                        maxContentWidth: maxContentWidth
                    )

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
                        .optionalMaxWidth(maxContentWidth)
                        .padding(.vertical, VSpacing.xs)
                }
            }
        }
    }

    // MARK: - Segment Grouping


    /// Groups of segments for rendering.
    private enum SegmentGroup {
        /// Consecutive text paragraphs combined for cross-paragraph selection.
        case selectableRun([MarkdownSegment])
        /// A heading rendered as its own block for spacing control.
        case heading(level: Int, text: String)
        case codeBlock(language: String?, code: String)
        case table(headers: [String], rows: [[String]])
        case image(alt: String, url: String)
        case horizontalRule
    }

    /// Cache for `computeGroupedSegments` results, keyed by the hash of the
    /// input segments array. Avoids recomputing the grouping on every body
    /// evaluation when segments haven't changed.
    @MainActor private static var groupedSegmentsCache: [Int: [SegmentGroup]] = [:]
    private static let groupedSegmentsCacheLimit = 200

    /// Groups consecutive text-selectable segments together so they render
    /// as a single Text view, enabling cross-paragraph text selection.
    private var groupedSegments: [SegmentGroup] {
        var hasher = Hasher()
        for segment in segments {
            hasher.combine(segment)
        }
        let key = hasher.finalize()

        if let cached = Self.groupedSegmentsCache[key] {
            return cached
        }

        let result = computeGroupedSegments()

        // Evict oldest entry if over limit (simple eviction — no LRU needed
        // since this cache is small and entries are cheap).
        if Self.groupedSegmentsCache.count >= Self.groupedSegmentsCacheLimit {
            Self.groupedSegmentsCache.removeValue(forKey: Self.groupedSegmentsCache.keys.first!)
        }
        Self.groupedSegmentsCache[key] = result
        return result
    }

    private func computeGroupedSegments() -> [SegmentGroup] {
        os_signpost(.begin, log: PerfSignposts.log, name: "markdownGroupSegments")
        defer { os_signpost(.end, log: PerfSignposts.log, name: "markdownGroupSegments") }
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
            case .text:
                currentRun.append(segment)
            case .heading(let level, let text):
                flushRun()
                groups.append(.heading(level: level, text: text))
            case .list:
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

    // MARK: - Cache Management

    /// Clears the attributed string cache.  Called when switching conversations
    /// or archiving a conversation to reclaim memory.
    static func clearAttributedStringCache() {
        groupedSegmentsCache.removeAll()
        MarkdownTableView.clearCellAttributedStringCache()
        SelectableTextView.clearCache()
    }
}

// MARK: - Code Block View

/// Renders a fenced code block with an optional language label and a
/// hover-revealed copy-to-clipboard button.
private struct CodeBlockView: View, Equatable {
    let language: String?
    let code: String
    let scaledCodeLabelSize: CGFloat
    let textColor: Color
    let mutedTextColor: Color
    let codeBackgroundColor: Color
    let maxContentWidth: CGFloat?

    @State private var isHovered = false

    static func == (lhs: CodeBlockView, rhs: CodeBlockView) -> Bool {
        lhs.language == rhs.language
            && lhs.code == rhs.code
            && lhs.scaledCodeLabelSize == rhs.scaledCodeLabelSize
            && lhs.textColor == rhs.textColor
            && lhs.mutedTextColor == rhs.mutedTextColor
            && lhs.codeBackgroundColor == rhs.codeBackgroundColor
            && lhs.maxContentWidth == rhs.maxContentWidth
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let language, !language.isEmpty {
                // Header bar with language label + copy button
                HStack {
                    Text(language)
                        .font(.system(size: scaledCodeLabelSize, weight: .medium))
                        .foregroundStyle(mutedTextColor)
                    Spacer()
                    VCopyButton(text: code, size: .compact)
                        .opacity(isHovered ? 1 : 0)
                        .animation(VAnimation.fast, value: isHovered)
                }
                .padding(.horizontal, VSpacing.sm)
                .padding(.top, VSpacing.xs)
            }

            ScrollView(.horizontal, showsIndicators: false) {
                Text(code)
                    .font(.custom("DMMono-Regular", size: 13))
                    .foregroundStyle(textColor)
                    .fixedSize(horizontal: true, vertical: true)
                    .padding(VSpacing.sm)
            }
        }
        .optionalMaxWidth(maxContentWidth)
        .background(codeBackgroundColor)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
        .overlay(alignment: .topTrailing) {
            if language == nil || language?.isEmpty == true {
                VCopyButton(text: code, size: .compact)
                    .opacity(isHovered ? 1 : 0)
                    .animation(VAnimation.fast, value: isHovered)
                    .padding(VSpacing.xs)
            }
        }
        .onHover { isHovered = $0 }
    }
}

// MARK: - Optional Max Width

private extension View {
    /// Applies `.frame(maxWidth:alignment:)` only when a width is provided.
    /// When `nil`, no frame is applied — the view shrink-wraps to its content.
    @ViewBuilder
    func optionalMaxWidth(_ width: CGFloat?) -> some View {
        if let width {
            self.frame(maxWidth: width, alignment: .leading)
        } else {
            self
        }
    }
}

