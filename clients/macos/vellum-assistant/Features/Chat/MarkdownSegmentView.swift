@preconcurrency import AppKit
import os
import SwiftUI
import VellumAssistantShared

/// Reusable view that renders parsed `MarkdownSegment` arrays.
/// Groups consecutive text-selectable segments (text, headings, lists) into
/// unified Text views so that text selection can span across paragraphs.
struct MarkdownSegmentView: View {
    let segments: [MarkdownSegment]
    var maxContentWidth: CGFloat? = VSpacing.chatBubbleMaxWidth
    var textColor: Color = VColor.contentDefault
    var secondaryTextColor: Color = VColor.contentSecondary
    var mutedTextColor: Color = VColor.contentTertiary
    var tintColor: Color = VColor.primaryBase
    var codeTextColor: Color = VColor.systemNegativeStrong
    var codeBackgroundColor: Color = VColor.surfaceActive
    var hrColor: Color = VColor.borderBase

    var body: some View {
        let groups = groupedSegments
        let scaledBodySize: CGFloat = 14
        let scaledCodeLabelSize: CGFloat = 11
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            ForEach(Array(groups.enumerated()), id: \.offset) { _, group in
                switch group {
                case .selectableRun(let runSegments):
                    let attributed = buildCombinedAttributedString(from: runSegments)
                    Text(attributed)
                        .font(.system(size: scaledBodySize))
                        .lineSpacing(4)
                        .foregroundColor(textColor)
                        .tint(tintColor)
                        .textSelection(.enabled)
                        .optionalMaxWidth(maxContentWidth)
                        // lineLimit(nil) wraps text in a single measurement pass, avoiding
                        // the double-measurement that fixedSize causes (measure at ideal
                        // size, then constrain to proposed width).
                        .lineLimit(nil)

                case .heading(let level, let headingText):
                    let headingFont: Font = switch level {
                    case 1: .system(size: 20, weight: .bold)
                    case 2: .system(size: 16, weight: .semibold)
                    case 3: .system(size: 14, weight: .semibold)
                    default: .system(size: 14, weight: .semibold)
                    }
                    Text(headingText)
                        .font(headingFont)
                        .foregroundColor(textColor)
                        .textSelection(.enabled)
                        .optionalMaxWidth(maxContentWidth)
                        // lineLimit(nil) avoids the double-measurement from fixedSize.
                        .lineLimit(nil)
                        .padding(.top, level == 1 ? 4 : 2)

                case .codeBlock(let language, let code):
                    VStack(alignment: .leading, spacing: 0) {
                        if let language, !language.isEmpty {
                            Text(language)
                                .font(.system(size: scaledCodeLabelSize, weight: .medium))
                                .foregroundColor(mutedTextColor)
                                .padding(.horizontal, VSpacing.sm)
                                .padding(.top, VSpacing.xs)
                        }
                        ScrollView(.horizontal, showsIndicators: false) {
                            Text(code)
                                .font(.custom("DMMono-Regular", size: 13))
                                .foregroundColor(textColor)
                                .textSelection(.enabled)
                                .fixedSize(horizontal: true, vertical: true)
                                .padding(VSpacing.sm)
                        }
                    }
                    .optionalMaxWidth(maxContentWidth)
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

    /// Groups consecutive text-selectable segments together so they render
    /// as a single Text view, enabling cross-paragraph text selection.
    /// `computeGroupedSegments` is a pure O(segment-count) switch/append walk
    /// with no string operations, so it is cheap enough to call on every body
    /// evaluation without a separate cache.
    private var groupedSegments: [SegmentGroup] { computeGroupedSegments() }

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

    // MARK: - Combined AttributedString

    /// Cache for expensive `buildCombinedAttributedString` results.
    /// Keyed by a hash of the segment descriptions so identical segment
    /// arrays return the cached value instead of re-parsing markdown and
    /// re-creating `AttributedString` on every SwiftUI body evaluation.
    /// Each entry stores (value, accessTime, estimatedBytes) for LRU eviction
    /// and byte-budget enforcement.
    @MainActor private static var attributedStringCache: [Int: (value: AttributedString, accessTime: Int, estimatedBytes: Int)] = [:]
    @MainActor private static var lruCounter: Int = 0
    private static let attributedStringCacheLimit = 200

    // MARK: - Cache Guardrails

    private static let maxCacheableTextLength = 10_000
    private static let maxCacheBytes = 5_000_000
    @MainActor static var estimatedCacheBytes: Int = 0

    /// Clears the attributed string cache.  Called when switching conversations
    /// or archiving a conversation to reclaim memory.
    static func clearAttributedStringCache() {
        attributedStringCache.removeAll()
        estimatedCacheBytes = 0
        MarkdownTableView.clearCellAttributedStringCache()
    }

    /// Rough character count of the text content within a segment array.
    private static func segmentTextLength(_ segments: [MarkdownSegment]) -> Int {
        segments.reduce(0) { total, seg in
            switch seg {
            case .text(let t): return total + t.count
            case .heading(_, let t): return total + t.count
            case .codeBlock(_, let c): return total + c.count
            case .list(let items): return total + items.reduce(0) { $0 + $1.text.count }
            case .table(let h, let r): return total + h.joined().count + r.flatMap { $0 }.joined().count
            case .image, .horizontalRule: return total
            }
        }
    }

    /// Evicts the oldest entries until `estimatedCacheBytes` drops below
    /// `maxCacheBytes`.
    @MainActor private static func evictIfOverBudget() {
        while estimatedCacheBytes > maxCacheBytes {
            guard let lruKey = attributedStringCache.min(by: { $0.value.accessTime < $1.value.accessTime })?.key else { break }
            let entry = attributedStringCache.removeValue(forKey: lruKey)
            estimatedCacheBytes -= entry?.estimatedBytes ?? 0
        }
    }

    /// Builds (or retrieves from cache) a single AttributedString from
    /// consecutive text-selectable segments.
    private func buildCombinedAttributedString(from segments: [MarkdownSegment]) -> AttributedString {
        os_signpost(.begin, log: PerfSignposts.log, name: "attributedStringBuild")
        defer { os_signpost(.end, log: PerfSignposts.log, name: "attributedStringBuild") }
        // Build a stable cache key from the segment contents and style
        // inputs that affect the output (e.g. secondaryTextColor for list
        // prefix coloring) so different visual contexts don't share entries.
        var hasher = Hasher()
        for segment in segments {
            hasher.combine(String(describing: segment))
        }
        hasher.combine(secondaryTextColor.description)
        hasher.combine(textColor.description)
        hasher.combine(codeTextColor.description)
        hasher.combine(codeBackgroundColor.description)
        let cacheKey = hasher.finalize()

        if let cached = Self.attributedStringCache[cacheKey] {
            Self.lruCounter += 1
            Self.attributedStringCache[cacheKey] = (cached.value, Self.lruCounter, cached.estimatedBytes)
            return cached.value
        }

        let result = Self.buildAttributedStringUncached(from: segments, secondaryTextColor: secondaryTextColor, codeTextColor: codeTextColor, codeBackgroundColor: codeBackgroundColor)

        // Skip caching for very long segment groups to avoid a single huge
        // entry evicting many smaller, more frequently accessed entries.
        let textLen = Self.segmentTextLength(segments)
        if textLen > Self.maxCacheableTextLength { return result }

        // Evict the least-recently-used entry when the cache is full.
        if Self.attributedStringCache.count >= Self.attributedStringCacheLimit {
            if let lruKey = Self.attributedStringCache.min(by: { $0.value.accessTime < $1.value.accessTime })?.key {
                let evicted = Self.attributedStringCache.removeValue(forKey: lruKey)
                Self.estimatedCacheBytes -= evicted?.estimatedBytes ?? 0
            }
        }
        Self.lruCounter += 1
        // Use 10 bytes per character to match the M3 fix in ChatBubble.swift (PR #11825);
        // AttributedString carries font, color, and paragraph metadata on top of raw text,
        // so a 3x multiplier underestimates real cost by ~3.3x and lets the cache silently
        // exceed its 5 MB budget.
        let cost = textLen * 10
        Self.attributedStringCache[cacheKey] = (result, Self.lruCounter, cost)
        Self.estimatedCacheBytes += cost
        Self.evictIfOverBudget()
        return result
    }

    /// Pure builder with no side effects — separated for caching.
    private static func buildAttributedStringUncached(
        from segments: [MarkdownSegment],
        secondaryTextColor: Color,
        codeTextColor: Color = VColor.systemNegativeStrong,
        codeBackgroundColor: Color = VColor.surfaceActive
    ) -> AttributedString {
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

            case .list(let items):
                for (itemIndex, item) in items.enumerated() {
                    if itemIndex > 0 {
                        result += AttributedString("\n")
                    }
                    let indentLevel = item.indent / 2
                    let indentString = String(repeating: "    ", count: indentLevel)
                    let prefix = item.ordered ? "\(item.number). " : "\u{2022} "

                    var prefixAttr = AttributedString(indentString + prefix)
                    prefixAttr.foregroundColor = secondaryTextColor

                    let itemAttr = (try? AttributedString(markdown: item.text, options: mdOptions))
                        ?? AttributedString(item.text)

                    // Apply hanging indent so wrapped lines align with item text
                    let prefixText = indentString + prefix
                    // Measure actual prefix width using the font
                    let font = NSFont.systemFont(ofSize: 14)
                    let prefixNS = NSString(string: prefixText)
                    let prefixWidth = prefixNS.size(withAttributes: [.font: font]).width
                    let paragraphStyle = NSMutableParagraphStyle()
                    paragraphStyle.headIndent = prefixWidth
                    paragraphStyle.firstLineHeadIndent = 0

                    var itemCombined = prefixAttr + itemAttr
                    itemCombined.applyParagraphStyle(paragraphStyle)
                    result += itemCombined
                }

            default:
                break
            }
        }

        // Apply background, text color, and padding to inline code spans
        var codeRanges: [Range<AttributedString.Index>] = []
        for run in result.runs {
            if let intent = run.inlinePresentationIntent, intent.contains(.code) {
                codeRanges.append(run.range)
            }
        }
        for range in codeRanges.reversed() {
            result[range].foregroundColor = codeTextColor
            result[range].backgroundColor = codeBackgroundColor
            var trailing = AttributedString("\u{2009}")
            trailing.backgroundColor = codeBackgroundColor
            result.insert(trailing, at: range.upperBound)
            var leading = AttributedString("\u{2009}")
            leading.backgroundColor = codeBackgroundColor
            result.insert(leading, at: range.lowerBound)
        }
        // Underline links so they are visually distinct from plain text
        for run in result.runs where result[run.range].link != nil {
            result[run.range].underlineStyle = .single
        }

        return result
    }
}

// MARK: - NSParagraphStyle Sendable workaround

private extension AttributedString {
    /// Applies a paragraph style via NSMutableAttributedString to avoid the
    /// compiler warning about NSParagraphStyle's revoked Sendable conformance.
    mutating func applyParagraphStyle(_ style: NSParagraphStyle) {
        let ns = NSMutableAttributedString(self)
        ns.addAttribute(.paragraphStyle, value: style, range: NSRange(location: 0, length: ns.length))
        self = AttributedString(ns)
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
