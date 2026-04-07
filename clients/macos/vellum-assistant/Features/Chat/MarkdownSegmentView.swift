@preconcurrency import AppKit
import os
import SwiftUI
import VellumAssistantShared

private final class AttributedStringCacheEntry: NSObject {
    let attributedString: AttributedString
    init(_ attributedString: AttributedString) { self.attributedString = attributedString }
}

#if os(macOS)
private final class MeasuredTextCacheEntry: NSObject {
    let nsAttributedString: NSAttributedString
    let size: CGSize
    init(nsAttributedString: NSAttributedString, size: CGSize) {
        self.nsAttributedString = nsAttributedString
        self.size = size
    }
}
#endif

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
    #if os(macOS)
    @ObservedObject private var typographyObserver = VFont.typographyObserver
    #endif

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
        let chatFont = VFont.chat
        let scaledCodeLabelSize: CGFloat = 11
        #if os(macOS)
        let typographyGeneration = typographyObserver.generation
        #endif
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            ForEach(Array(groups.enumerated()), id: \.offset) { _, group in
                switch group {
                case .selectableRun(let runSegments):
                    #if os(macOS)
                    SelectableRunView(
                        markdownView: self,
                        runSegments: runSegments,
                        typographyGeneration: typographyGeneration
                    )
                    #else
                    let attributed = buildCombinedAttributedString(from: runSegments)
                    Text(attributed)
                        .font(chatFont)
                        .lineSpacing(4)
                        .foregroundStyle(textColor)
                        .tint(tintColor)
                        .optionalMaxWidth(maxContentWidth)
                        .lineLimit(nil)
                        .fixedSize(horizontal: false, vertical: true)
                    #endif

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
        /// Consecutive text paragraphs and headings combined for cross-paragraph selection.
        case selectableRun([MarkdownSegment])
        case codeBlock(language: String?, code: String)
        case table(headers: [String], rows: [[String]])
        case image(alt: String, url: String)
        case horizontalRule
    }

    #if os(macOS)
    private struct SelectableRunView: View {
        let markdownView: MarkdownSegmentView
        let runSegments: [MarkdownSegment]
        let typographyGeneration: Int

        var body: some View {
            let measurement = markdownView.resolveSelectableRunMeasurementResult(
                runSegments,
                typographyGeneration: typographyGeneration
            )

            VSelectableTextView(
                attributedString: measurement.nsAttributedString,
                maxWidth: markdownView.maxContentWidth,
                lineSpacing: 4,
                tintColor: NSColor(markdownView.tintColor),
                useExternalSizing: true
            )
            .frame(
                width: measurement.size.width,
                height: measurement.size.height,
                alignment: .leading
            )
        }
    }
    #endif

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
            case .heading:
                currentRun.append(segment)
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
    /// Keyed by a combined hash of the segment values and style colors so
    /// identical segment arrays return the cached value instead of re-parsing
    /// markdown and re-creating `AttributedString` on every SwiftUI body
    /// evaluation. NSCache handles eviction automatically under memory pressure.
    @MainActor private static var attributedStringCache: NSCache<NSNumber, AttributedStringCacheEntry> = {
        let cache = NSCache<NSNumber, AttributedStringCacheEntry>()
        cache.countLimit = 1_000
        cache.totalCostLimit = 10_000_000
        return cache
    }()

    #if os(macOS)
    @MainActor private static var measuredTextCache: NSCache<NSNumber, MeasuredTextCacheEntry> = {
        let cache = NSCache<NSNumber, MeasuredTextCacheEntry>()
        cache.countLimit = 500
        cache.totalCostLimit = 20_000_000 // ~20 MB
        return cache
    }()

    @MainActor private static var typographyRetryScheduled = false
    @MainActor private static var typographyRetryToken: Int = 0
    @MainActor private static var typographyRetryTimestamps: [TimeInterval] = []

    #if DEBUG
    /// Exposed for testing: number of cache insertions into `measuredTextCache`.
    /// NSCache doesn't expose its count, so we maintain a parallel counter.
    @MainActor static var _measuredTextCacheInsertCount: Int = 0
    /// Exposed for testing: number of times `buildAttributedStringUncached` was
    /// called (i.e. `attributedStringCache` misses).
    @MainActor static var _attributedStringBuildCount: Int = 0
    #endif
    #endif

    // MARK: - Cache Guardrails

    private static let maxCacheableTextLength = 10_000
    #if os(macOS)
    private static let typographyRetryDelayNanoseconds: UInt64 = 75_000_000
    private static let typographyRetryWindowSeconds: TimeInterval = 1.0
    private static let maxTypographyRetriesPerWindow = 2
    #endif
    /// Cache for prefix width measurements to avoid repeated Core Text layout calls.
    @MainActor private static var prefixWidthCache: [String: CGFloat] = [:]

    /// Clears the attributed string cache.  Called when switching conversations
    /// or archiving a conversation to reclaim memory.
    static func clearAttributedStringCache() {
        attributedStringCache.removeAllObjects()
        prefixWidthCache.removeAll()
        groupedSegmentsCache.removeAll()
        MarkdownTableView.clearCellAttributedStringCache()
        #if os(macOS)
        measuredTextCache.removeAllObjects()
        typographyRetryScheduled = false
        typographyRetryToken &+= 1
        typographyRetryTimestamps.removeAll()
        #if DEBUG
        _measuredTextCacheInsertCount = 0
        _attributedStringBuildCount = 0
        #endif
        #endif
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

    /// Builds (or retrieves from cache) a single AttributedString from
    /// consecutive text-selectable segments.
    private func buildCombinedAttributedString(from segments: [MarkdownSegment]) -> AttributedString {
        os_signpost(.begin, log: PerfSignposts.log, name: "attributedStringBuild")
        defer { os_signpost(.end, log: PerfSignposts.log, name: "attributedStringBuild") }
        // Build a stable cache key from the segment contents, style inputs,
        // and typography generation so cached heading fonts are invalidated
        // when DM Sans finishes loading or typography state changes.
        var hasher = Hasher()
        for segment in segments {
            hasher.combine(segment)
        }
        hasher.combine(secondaryTextColor.description)
        hasher.combine(textColor.description)
        hasher.combine(codeTextColor.description)
        hasher.combine(codeBackgroundColor.description)
        hasher.combine(VFont.typographyGeneration)
        let cacheKey = hasher.finalize()

        let cacheKeyNS = cacheKey as NSNumber
        if let cached = Self.attributedStringCache.object(forKey: cacheKeyNS)?.attributedString {
            return cached
        }

        let result = Self.buildAttributedStringUncached(from: segments, secondaryTextColor: secondaryTextColor, codeTextColor: codeTextColor, codeBackgroundColor: codeBackgroundColor)
        #if DEBUG
        Self._attributedStringBuildCount += 1
        #endif

        // Skip caching for very long segment groups to avoid a single huge
        // entry evicting many smaller, more frequently accessed entries.
        let textLen = Self.segmentTextLength(segments)
        if textLen > Self.maxCacheableTextLength { return result }

        // Use 10 bytes per character to estimate cost; AttributedString carries
        // font, color, and paragraph metadata on top of raw text.
        Self.attributedStringCache.setObject(AttributedStringCacheEntry(result), forKey: cacheKeyNS, cost: textLen * 10)
        return result
    }

    #if os(macOS)
    struct SelectableRunMeasurementResult {
        let nsAttributedString: NSAttributedString
        let size: CGSize
        let hasUnresolvedEmphasis: Bool
    }

    /// Computes or retrieves from cache the `(NSAttributedString, CGSize)` pair
    /// for a selectable text run.  `internal` so `@testable import` tests can
    /// exercise the cache directly (SwiftUI `body` evaluation does not force
    /// `ForEach` row closures to execute in a unit-test context).
    @MainActor func resolveSelectableRunMeasurement(
        _ runSegments: [MarkdownSegment]
    ) -> (NSAttributedString, CGSize) {
        let result = resolveSelectableRunMeasurementResult(runSegments)
        return (result.nsAttributedString, result.size)
    }

    @MainActor func resolveSelectableRunMeasurementResult(
        _ runSegments: [MarkdownSegment],
        typographyGeneration: Int? = nil
    ) -> SelectableRunMeasurementResult {
        let chatFonts = VFont.resolvedChatMarkdownFontSet()
        var hasher = Hasher()
        for segment in runSegments { hasher.combine(segment) }
        hasher.combine(textColor.description)
        hasher.combine(secondaryTextColor.description)
        hasher.combine(codeTextColor.description)
        hasher.combine(codeBackgroundColor.description)
        let effectiveMaxWidth = maxContentWidth ?? VSpacing.chatBubbleMaxWidth
        hasher.combine(effectiveMaxWidth)
        hasher.combine(typographyGeneration ?? VFont.typographyGeneration)
        for entry in chatFonts.diagnosticPostScriptNames.sorted(by: { $0.key < $1.key }) {
            hasher.combine(entry.key)
            hasher.combine(entry.value)
        }
        let key = hasher.finalize()

        let keyNS = key as NSNumber
        if let cached = Self.measuredTextCache.object(forKey: keyNS) {
            return SelectableRunMeasurementResult(
                nsAttributedString: cached.nsAttributedString,
                size: cached.size,
                hasUnresolvedEmphasis: false
            )
        }

        os_signpost(.begin, log: PerfSignposts.log, name: "selectableRunMeasure")
        let attributed = buildCombinedAttributedString(from: runSegments)
        let (nsAttributed, hasUnresolvedEmphasis) = Self.convertToNSAttributedString(
            attributed,
            fontSet: chatFonts,
            textColor: NSColor(textColor)
        )
        let size = VSelectableTextView.measureSize(
            attributedString: nsAttributed,
            lineSpacing: 4,
            maxWidth: effectiveMaxWidth
        )
        os_signpost(.end, log: PerfSignposts.log, name: "selectableRunMeasure")

        // Don't cache results where emphasis was expected but not applied —
        // the next render will rebuild from scratch, which may succeed.
        let textLen = Self.segmentTextLength(runSegments)
        if !hasUnresolvedEmphasis && textLen <= Self.maxCacheableTextLength {
            Self.measuredTextCache.setObject(
                MeasuredTextCacheEntry(nsAttributedString: nsAttributed, size: size),
                forKey: keyNS,
                cost: textLen * 15
            )
            #if DEBUG
            Self._measuredTextCacheInsertCount += 1
            #endif
        } else if hasUnresolvedEmphasis {
            Self.scheduleTypographyRetryIfNeeded()
        }
        return SelectableRunMeasurementResult(
            nsAttributedString: nsAttributed,
            size: size,
            hasUnresolvedEmphasis: hasUnresolvedEmphasis
        )
    }

    @MainActor
    private static func scheduleTypographyRetryIfNeeded() {
        let now = ProcessInfo.processInfo.systemUptime
        typographyRetryTimestamps.removeAll {
            now - $0 > typographyRetryWindowSeconds
        }
        guard !typographyRetryScheduled,
              typographyRetryTimestamps.count < maxTypographyRetriesPerWindow else { return }

        typographyRetryScheduled = true
        typographyRetryToken &+= 1
        typographyRetryTimestamps.append(now)
        let retryToken = typographyRetryToken

        Task { @MainActor in
            try? await Task.sleep(nanoseconds: typographyRetryDelayNanoseconds)
            guard retryToken == typographyRetryToken else { return }
            typographyRetryScheduled = false
            VFont.bumpTypographyGeneration()
        }
    }
    #endif

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
                var attributed: AttributedString
                do {
                    attributed = try AttributedString(markdown: text, options: mdOptions)
                } catch {
                    mdConvertLog.warning("AttributedString(markdown:) failed for .text segment: \(error.localizedDescription, privacy: .public)")
                    attributed = AttributedString(text)
                }
                AttributedStringAutolinker.autolinkBareURLs(in: &attributed)
                result += attributed

            case .heading(let level, let text):
                var headingAttr: AttributedString
                do {
                    headingAttr = try AttributedString(markdown: text, options: mdOptions)
                } catch {
                    mdConvertLog.warning("AttributedString(markdown:) failed for .heading segment: \(error.localizedDescription, privacy: .public)")
                    headingAttr = AttributedString(text)
                }
                AttributedStringAutolinker.autolinkBareURLs(in: &headingAttr)
                let headingSize: CGFloat = switch level {
                case 1: 20
                case 2: 16
                default: 14
                }
                let weightValue: Int = level == 1 ? 700 : 600
                headingAttr.appKit.font = VFont.resolvedDMSansFont(weight: weightValue, size: headingSize)
                if index > 0 {
                    let paraStyle = NSMutableParagraphStyle()
                    paraStyle.paragraphSpacingBefore = level == 1 ? 8 : 4
                    headingAttr.applyParagraphStyle(paraStyle)
                }
                result += headingAttr

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

                    var itemAttr: AttributedString
                    do {
                        itemAttr = try AttributedString(markdown: item.text, options: mdOptions)
                    } catch {
                        mdConvertLog.warning("AttributedString(markdown:) failed for .list item: \(error.localizedDescription, privacy: .public)")
                        itemAttr = AttributedString(item.text)
                    }
                    AttributedStringAutolinker.autolinkBareURLs(in: &itemAttr)

                    // Apply hanging indent so wrapped lines align with item text
                    let prefixText = indentString + prefix
                    // Measure actual prefix width using the font (cached to avoid repeated Core Text calls)
                    let prefixWidth: CGFloat
                    if let cached = prefixWidthCache[prefixText] {
                        prefixWidth = cached
                    } else {
                        let font = VFont.resolvedChatMarkdownFontSet().regular
                        let prefixNS = NSString(string: prefixText)
                        prefixWidth = prefixNS.size(withAttributes: [.font: font]).width
                        if prefixWidthCache.count < 200 {
                            prefixWidthCache[prefixText] = prefixWidth
                        }
                    }
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
        // Synthetic italic/bold is applied later in convertToNSAttributedString
        // where we work directly with NSFont, avoiding the SwiftUI Font→NSFont
        // round-trip that loses the oblique transform during AttributedString→
        // NSAttributedString conversion.

        // Underline links so they are visually distinct from plain text
        for run in result.runs where result[run.range].link != nil {
            result[run.range].underlineStyle = .single
        }

        return result
    }

    // MARK: - NSAttributedString Conversion

    private static let mdConvertLog = Logger(subsystem: Bundle.appBundleIdentifier, category: "MarkdownConvert")

    #if os(macOS)
    /// Converts a SwiftUI `AttributedString` to `NSAttributedString` with a
    /// base font and text color applied as defaults. Runs that already carry
    /// explicit font or color attributes (e.g. inline code, bold, italic)
    /// keep their values; the defaults fill in where no attribute is set.
    ///
    /// Returns the converted `NSAttributedString` and a flag indicating
    /// whether emphasis runs were detected but none could be applied
    /// (all skipped by guards). When `true`, the caller should avoid
    /// caching the result so the next render can retry.
    static func convertToNSAttributedString(
        _ source: AttributedString,
        fontSet: VFont.ChatMarkdownFontSet,
        textColor: NSColor
    ) -> (NSAttributedString, Bool) {
        // Pre-collect emphasis info from the source AttributedString.
        // Reading inlinePresentationIntent directly from AttributedString.runs
        // avoids relying on NSAttributedString attribute bridging, which can
        // silently drop InlinePresentationIntent (a Swift struct / OptionSet)
        // when it doesn't bridge to NSNumber during the conversion.
        struct EmphasisRun {
            let utf16Offset: Int
            let utf16Length: Int
            let intent: InlinePresentationIntent
            let hasExplicitFont: Bool
        }
        var emphasisRuns: [EmphasisRun] = []
        var utf16Offset = 0
        for run in source.runs {
            let runContent = source[run.range]
            let utf16Length = String(runContent.characters).utf16.count
            if let intent = runContent.inlinePresentationIntent,
               intent.contains(.emphasized) || intent.contains(.stronglyEmphasized) {
                emphasisRuns.append(EmphasisRun(
                    utf16Offset: utf16Offset,
                    utf16Length: utf16Length,
                    intent: intent,
                    hasExplicitFont: runContent.font != nil || runContent.appKit.font != nil
                ))
            }
            utf16Offset += utf16Length
        }

        let ns = NSMutableAttributedString(source)
        let fullRange = NSRange(location: 0, length: ns.length)

        // Validate offset consistency — if the AttributedString→NSAttributedString
        // conversion changed the text encoding (e.g. Unicode normalization), the
        // pre-computed offsets are wrong. Recompute from the source ranges directly.
        if utf16Offset != ns.length && !emphasisRuns.isEmpty {
            mdConvertLog.warning("UTF-16 offset mismatch: computed \(utf16Offset) vs NSAttributedString length \(ns.length) — recomputing emphasis offsets")
            emphasisRuns.removeAll()
            for run in source.runs {
                if let intent = source[run.range].inlinePresentationIntent,
                   intent.contains(.emphasized) || intent.contains(.stronglyEmphasized) {
                    let prefixStr = String(source.characters[source.startIndex..<run.range.lowerBound])
                    let nsOffset = (prefixStr as NSString).length
                    let runStr = String(source[run.range].characters)
                    let nsLen = (runStr as NSString).length
                    emphasisRuns.append(EmphasisRun(
                        utf16Offset: nsOffset,
                        utf16Length: nsLen,
                        intent: intent,
                        hasExplicitFont: source[run.range].font != nil || source[run.range].appKit.font != nil
                    ))
                }
            }
        }

        // Apply synthetic italic/bold to emphasized runs.
        // DM Sans doesn't ship an italic font face, so we apply a synthetic
        // oblique via affine transform. This is done on the NSMutableAttributedString
        // (not the SwiftUI AttributedString) because SwiftUI Font attributes set via
        // Font(nsFont) don't reliably survive the AttributedString→NSAttributedString
        // conversion — the oblique transform is lost, leaving plain text.
        var unresolvedEmphasisCount = 0
        var loggedUnresolvedFonts = false
        let font = fontSet.regular

        func logUnresolvedFontsIfNeeded() {
            guard !loggedUnresolvedFonts else { return }
            loggedUnresolvedFonts = true
            let diagnostics = fontSet.diagnosticPostScriptNames
                .sorted { $0.key < $1.key }
                .map { "\($0.key)=\($0.value)" }
                .joined(separator: ", ")
            mdConvertLog.warning(
                "Expected DM Sans emphasis fonts (family DM Sans), resolved: \(diagnostics, privacy: .public)"
            )
        }

        func fontHasExpectedTraits(_ font: NSFont, isEmphasized: Bool, isBold: Bool) -> Bool {
            let matrix = CTFontGetMatrix(font as CTFont)
            let hasOblique = abs(matrix.b) > 0.0001 || abs(matrix.c) > 0.0001
            let hasBoldWeight: Bool
            if isBold,
               let variations = CTFontCopyVariation(font as CTFont) as? [NSNumber: NSNumber],
               let weightValue = variations[0x77676874 as NSNumber] {
                hasBoldWeight = abs(CGFloat(truncating: weightValue) - 700) < 0.5
            } else {
                hasBoldWeight = !isBold
            }

            return (!isEmphasized || hasOblique) && hasBoldWeight
        }

        for emphRun in emphasisRuns {
            guard !emphRun.intent.contains(.code) else { continue }
            // Skip runs that already have an explicit font (e.g. headings)
            guard !emphRun.hasExplicitFont else { continue }
            let nsRange = NSRange(location: emphRun.utf16Offset, length: emphRun.utf16Length)
            guard nsRange.location + nsRange.length <= ns.length else {
                mdConvertLog.warning("Emphasis range \(nsRange.location)+\(nsRange.length) exceeds NSAttributedString length \(ns.length) — skipping")
                unresolvedEmphasisCount += 1
                continue
            }
            let isEmph = emphRun.intent.contains(.emphasized)
            let isBold = emphRun.intent.contains(.stronglyEmphasized)
            if isEmph && isBold {
                guard fontSet.boldItalicIsResolved else {
                    unresolvedEmphasisCount += 1
                    logUnresolvedFontsIfNeeded()
                    continue
                }
                ns.addAttribute(.font, value: fontSet.boldItalic, range: nsRange)
            } else if isEmph {
                guard fontSet.italicIsResolved else {
                    unresolvedEmphasisCount += 1
                    logUnresolvedFontsIfNeeded()
                    continue
                }
                ns.addAttribute(.font, value: fontSet.italic, range: nsRange)
            } else if isBold {
                guard fontSet.boldIsResolved else {
                    unresolvedEmphasisCount += 1
                    logUnresolvedFontsIfNeeded()
                    continue
                }
                ns.addAttribute(.font, value: fontSet.bold, range: nsRange)
            }
        }

        for emphRun in emphasisRuns where !emphRun.intent.contains(.code) && !emphRun.hasExplicitFont && emphRun.utf16Length > 0 {
            let nsRange = NSRange(location: emphRun.utf16Offset, length: emphRun.utf16Length)
            guard nsRange.location + nsRange.length <= ns.length else { continue }
            guard let actualFont = ns.attribute(.font, at: nsRange.location, effectiveRange: nil) as? NSFont else {
                unresolvedEmphasisCount += 1
                logUnresolvedFontsIfNeeded()
                continue
            }
            let isEmph = emphRun.intent.contains(.emphasized)
            let isBold = emphRun.intent.contains(.stronglyEmphasized)
            if !fontHasExpectedTraits(actualFont, isEmphasized: isEmph, isBold: isBold) {
                unresolvedEmphasisCount += 1
                logUnresolvedFontsIfNeeded()
            }
        }

        let hasUnresolvedEmphasis = unresolvedEmphasisCount > 0
        if hasUnresolvedEmphasis {
            mdConvertLog.warning(
                "Emphasis runs detected (\(emphasisRuns.count)) with \(unresolvedEmphasisCount) unresolved run(s) — skipping cache"
            )
        }

        // Apply base font where no explicit font attribute exists
        ns.enumerateAttribute(.font, in: fullRange, options: []) { value, range, _ in
            if value == nil {
                ns.addAttribute(.font, value: font, range: range)
            }
        }

        // Apply base text color where no explicit foreground color exists
        ns.enumerateAttribute(.foregroundColor, in: fullRange, options: []) { value, range, _ in
            if value == nil {
                ns.addAttribute(.foregroundColor, value: textColor, range: range)
            }
        }

        return (ns, hasUnresolvedEmphasis)
    }
    #endif
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

    /// Line height derived from the actual monospace font metrics via
    /// NSLayoutManager, so it stays correct if the font or size changes.
    private static let codeLineHeight: CGFloat = {
        let lm = NSLayoutManager()
        return ceil(lm.defaultLineHeight(for: VFont.nsMono))
    }()

    /// Maximum height for long code blocks inside LazyVStack cells.
    /// Content exceeding this is vertically scrollable.
    private static let maxCodeBlockHeight: CGFloat = 400

    /// Line threshold derived from maxCodeBlockHeight / codeLineHeight.
    /// Content above this count takes the capped-height ScrollView path.
    private static let lineThreshold: Int = Int(maxCodeBlockHeight / codeLineHeight)

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

            let codeLineCount = code.utf8.reduce(1) { $0 + ($1 == 0x0A ? 1 : 0) }
            let isLong = codeLineCount > Self.lineThreshold || (codeLineCount == 1 && code.utf8.count > 50_000)

            if isLong {
                // Long code: both horizontal and vertical scroll, capped height.
                // .frame(height:) compiles to _FixedSizeLayout — O(1), never
                // measures children. Safe inside LazyVStack cells.
                ScrollView([.horizontal, .vertical], showsIndicators: true) {
                    Text(code)
                        .font(.custom("DMMono-Regular", size: 13))
                        .foregroundStyle(textColor)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: true, vertical: true)
                        .padding(VSpacing.sm)
                }
                .frame(height: Self.maxCodeBlockHeight)
            } else {
                // Short code: horizontal scroll only, natural height.
                let codeBlockHeight = CGFloat(codeLineCount) * Self.codeLineHeight + VSpacing.sm * 2
                ScrollView(.horizontal, showsIndicators: false) {
                    Text(code)
                        .font(.custom("DMMono-Regular", size: 13))
                        .foregroundStyle(textColor)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: true, vertical: true)
                        .padding(VSpacing.sm)
                }
                .frame(height: codeBlockHeight)
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
