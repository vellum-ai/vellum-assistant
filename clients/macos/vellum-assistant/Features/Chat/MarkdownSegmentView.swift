@preconcurrency import AppKit
import SwiftUI
import VellumAssistantShared

/// Reusable view that renders parsed `MarkdownSegment` arrays.
/// Groups consecutive text-selectable segments (text, headings, lists) into
/// unified Text views so that text selection can span across paragraphs.
struct MarkdownSegmentView: View {
    let segments: [MarkdownSegment]
    var isStreaming: Bool = false
    var maxContentWidth: CGFloat? = 520
    var textColor: Color = VColor.textPrimary
    var secondaryTextColor: Color = VColor.textSecondary
    var mutedTextColor: Color = VColor.textMuted
    var tintColor: Color = VColor.accent
    var codeBackgroundColor: Color = VColor.codeBackground
    var hrColor: Color = VColor.surfaceBorder

    @Environment(\.conversationZoomScale) private var zoomScale

    var body: some View {
        let groups = groupedSegments
        let scaledBodySize: CGFloat = 13 * zoomScale
        let scaledCodeLabelSize: CGFloat = 11 * zoomScale
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            ForEach(Array(groups.enumerated()), id: \.offset) { _, group in
                switch group {
                case .selectableRun(let runSegments):
                    let attributed = buildCombinedAttributedString(from: runSegments)
                    Text(attributed)
                        .font(.system(size: scaledBodySize))
                        .lineSpacing(4)
                        .foregroundColor(textColor)
                        .tint(tintColor)
                        .selectableText(!isStreaming)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: maxContentWidth ?? .infinity, alignment: .leading)

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
                                .font(.custom("DMMono-Regular", size: 13 * zoomScale))
                                .foregroundColor(textColor)
                                .selectableText(!isStreaming)
                                .fixedSize(horizontal: true, vertical: true)
                                .padding(VSpacing.sm)
                        }
                    }
                    .frame(maxWidth: maxContentWidth ?? .infinity, alignment: .leading)
                    .background(codeBackgroundColor)
                    .clipShape(RoundedRectangle(cornerRadius: VRadius.md))

                case .table(let headers, let rows):
                    MarkdownTableView(headers: headers, rows: rows, maxWidth: maxContentWidth ?? .infinity, isStreaming: isStreaming)

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

    /// Clears the attributed string cache.  Called when switching threads
    /// or archiving a conversation to reclaim memory.
    static func clearAttributedStringCache() {
        attributedStringCache.removeAll()
        estimatedCacheBytes = 0
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
        // Build a stable cache key from the segment contents and style
        // inputs that affect the output (e.g. secondaryTextColor for list
        // prefix coloring, zoomScale for font sizing) so different visual
        // contexts don't share entries.
        var hasher = Hasher()
        for segment in segments {
            hasher.combine(String(describing: segment))
        }
        hasher.combine(secondaryTextColor.description)
        hasher.combine(textColor.description)
        hasher.combine(codeBackgroundColor.description)
        hasher.combine(zoomScale)
        let cacheKey = hasher.finalize()

        if let cached = Self.attributedStringCache[cacheKey] {
            Self.lruCounter += 1
            Self.attributedStringCache[cacheKey] = (cached.value, Self.lruCounter, cached.estimatedBytes)
            return cached.value
        }

        let result = Self.buildAttributedStringUncached(from: segments, secondaryTextColor: secondaryTextColor, codeTextColor: textColor, codeBackgroundColor: codeBackgroundColor, zoomScale: zoomScale)

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
        let cost = textLen * 3
        Self.attributedStringCache[cacheKey] = (result, Self.lruCounter, cost)
        Self.estimatedCacheBytes += cost
        Self.evictIfOverBudget()
        return result
    }

    /// Pure builder with no side effects — separated for caching.
    private static func buildAttributedStringUncached(
        from segments: [MarkdownSegment],
        secondaryTextColor: Color,
        codeTextColor: Color = VColor.codeText,
        codeBackgroundColor: Color = VColor.codeBackground,
        zoomScale: CGFloat = 1.0
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

            case .heading(let level, let headingText):
                var heading = AttributedString(headingText)
                heading.font = switch level {
                case 1: .system(size: 20 * zoomScale, weight: .bold)
                case 2: .system(size: 17 * zoomScale, weight: .semibold)
                case 3: .system(size: 14 * zoomScale, weight: .semibold)
                default: .system(size: 13 * zoomScale, weight: .semibold)
                }
                result += heading

            case .list(let items):
                let indentStep: CGFloat = 16 * zoomScale
                let scaledSize: CGFloat = 13 * zoomScale
                let font = NSFont.systemFont(ofSize: scaledSize)

                for (itemIndex, item) in items.enumerated() {
                    if itemIndex > 0 {
                        result += AttributedString("\n")
                    }

                    let indentLevel = CGFloat(item.indent / 2)
                    let leftMargin = indentLevel * indentStep
                    let prefix = item.ordered ? "\(item.number). " : "\u{2022} "

                    let prefixSize = (prefix as NSString).size(withAttributes: [.font: font])
                    let textColumn = leftMargin + prefixSize.width

                    nonisolated(unsafe) let paraStyle = NSMutableParagraphStyle()
                    paraStyle.lineSpacing = 4
                    paraStyle.firstLineHeadIndent = leftMargin
                    paraStyle.headIndent = textColumn
                    paraStyle.tabStops = []

                    var prefixAttr = AttributedString(prefix)
                    prefixAttr.foregroundColor = secondaryTextColor
                    prefixAttr.font = .system(size: scaledSize)
                    prefixAttr.applyParagraphStyle(paraStyle)
                    result += prefixAttr

                    var itemAttr = (try? AttributedString(markdown: item.text, options: mdOptions))
                        ?? AttributedString(item.text)
                    itemAttr.applyParagraphStyle(paraStyle)
                    result += itemAttr
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

        return result
    }
}

// MARK: - Conditional text selection

extension View {
    /// Wraps `.textSelection(.enabled)` / `.textSelection(.disabled)` behind a
    /// `@ViewBuilder` branch so the compiler doesn't try to unify the two
    /// distinct `TextSelectability` conformances in a single ternary expression.
    @ViewBuilder func selectableText(_ enabled: Bool) -> some View {
        if enabled {
            self.textSelection(.enabled)
        } else {
            self.textSelection(.disabled)
        }
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
