import AppKit
import CoreText
import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

#if canImport(SwiftMath)
import SwiftMath
#endif

@MainActor
final class MarkdownSegmentViewTests: XCTestCase {
    private static let markdownOptions = AttributedString.MarkdownParsingOptions(
        interpretedSyntax: .inlineOnlyPreservingWhitespace
    )

    override class func setUp() {
        super.setUp()
        registerTestFonts()
    }

    override func setUp() {
        super.setUp()
        MarkdownSegmentView.clearAttributedStringCache()
        ChatBubble.segmentCache.removeAllObjects()
        ChatBubble.lastStreamingSegments = nil
        ChatBubble.lastStreamingParseTime = 0
        #if DEBUG
        VFont._chatMarkdownFontSetOverride = nil
        #endif
    }

    override func tearDown() {
        #if DEBUG
        VFont._chatMarkdownFontSetOverride = nil
        #endif
        MarkdownSegmentView.clearAttributedStringCache()
        ChatBubble.segmentCache.removeAllObjects()
        ChatBubble.lastStreamingSegments = nil
        ChatBubble.lastStreamingParseTime = 0
        super.tearDown()
    }

    func testItalicMarkdownAppliesObliquenessAttribute() throws {
        let (rendered, hasUnresolvedEmphasis) = makeRenderedMarkdown("*settles in*")
        let font = try renderedFont(from: rendered)
        let obliqueness = renderedObliqueness(from: rendered)

        XCTAssertFalse(hasUnresolvedEmphasis)
        XCTAssertEqual(familyName(for: font), "DM Sans")
        XCTAssertNotNil(obliqueness, "Italic emphasis must set the .obliqueness attribute")
        XCTAssertGreaterThan(
            abs(CGFloat(truncating: obliqueness!)), 0.01,
            "Italic emphasis must apply a non-zero obliqueness"
        )
    }

    func testItalicAtStartOfMultiLineRendersWithObliqueness() throws {
        let input = "*...the room goes completely quiet*\n\na following paragraph with no emphasis"

        let source = try makeAttributedString(from: input)
        let emphasizedRuns = source.runs.filter {
            $0.inlinePresentationIntent?.contains(.emphasized) == true
        }
        XCTAssertFalse(
            emphasizedRuns.isEmpty,
            "Apple parser must emit .emphasized for `*...text*` at start of multi-line input. "
            + "Got runs: \(source.runs.map { (String(source[$0.range].characters), $0.inlinePresentationIntent) })"
        )

        let (rendered, hasUnresolvedEmphasis) = makeRenderedMarkdown(input)
        XCTAssertFalse(hasUnresolvedEmphasis)
        let font = try renderedFont(from: rendered)
        XCTAssertEqual(familyName(for: font), "DM Sans")
        let obliqueness = renderedObliqueness(from: rendered)
        XCTAssertNotNil(obliqueness, "Emphasis at offset 0 must have a non-nil obliqueness attribute")
        XCTAssertGreaterThan(
            abs(CGFloat(truncating: obliqueness!)), 0.01,
            "Emphasis at offset 0 must apply a non-zero obliqueness"
        )
    }

    /// Exercises the FULL chat-message rendering pipeline (parseMarkdownSegments
    /// → MarkdownSegmentView convert) when emphasis appears at the start of a
    /// multi-paragraph message, with additional emphasis spans embedded in
    /// later paragraphs. Verifies that the obliqueness attribute survives all
    /// the way to NSTextStorage — closing the gap that plain font-matrix slant
    /// has, where NSTextView can normalize the matrix away during
    /// setAttributedString.
    func testItalicFirstLineSurvivesFullMessagePipeline() throws {
        let input = """
        *...the room goes completely quiet*

        first paragraph after the opening italics, no emphasis here.

        second paragraph with mid-line *emphasis.*

        third paragraph with trailing *italics*. that's it.
        """

        let segments = parseMarkdownSegments(input)
        guard case .text(let combinedText) = segments.first else {
            return XCTFail("Expected first segment to be .text, got \(segments)")
        }
        XCTAssertTrue(
            combinedText.hasPrefix("*...the room goes completely quiet*"),
            "Pipeline must preserve the italic markers on the first line; got prefix: "
            + "\(String(combinedText.prefix(60)))"
        )

        let source = try makeAttributedString(from: combinedText)
        let firstRun = source.runs.first!
        let firstRunText = String(source[firstRun.range].characters)
        let firstRunIntent = firstRun.inlinePresentationIntent
        XCTAssertTrue(
            firstRunIntent?.contains(.emphasized) == true,
            "First run must be .emphasized. Got text=\(firstRunText), intent=\(String(describing: firstRunIntent))"
        )

        let view = MarkdownSegmentView(segments: segments)
        let result = view.resolveSelectableRunMeasurementResult(segments)
        XCTAssertFalse(result.hasUnresolvedEmphasis)
        let obliquenessAtZero = result.nsAttributedString.attribute(.obliqueness, at: 0, effectiveRange: nil) as? NSNumber
        XCTAssertNotNil(obliquenessAtZero, "First-line emphasis must apply obliqueness via the full pipeline")
        XCTAssertGreaterThan(abs(CGFloat(truncating: obliquenessAtZero!)), 0.01)

        // Feed through the real NSTextView path used by VSelectableTextView —
        // .obliqueness must survive the bridge that previously dropped font
        // matrix transforms.
        let textStorage = NSTextStorage()
        let layoutManager = NSLayoutManager()
        textStorage.addLayoutManager(layoutManager)
        let textContainer = NSTextContainer(size: NSSize(width: 600, height: CGFloat.greatestFiniteMagnitude))
        textContainer.lineFragmentPadding = 0
        layoutManager.addTextContainer(textContainer)
        textStorage.setAttributedString(result.nsAttributedString)
        layoutManager.ensureLayout(for: textContainer)

        let displayedObliqueness = textStorage.attribute(.obliqueness, at: 0, effectiveRange: nil) as? NSNumber
        XCTAssertNotNil(displayedObliqueness, "NSTextStorage must keep the .obliqueness attribute at offset 0")
        XCTAssertGreaterThan(abs(CGFloat(truncating: displayedObliqueness!)), 0.01)
    }

    func testBoldMarkdownUsesWeightedDMSansFont() throws {
        let (rendered, hasUnresolvedEmphasis) = makeRenderedMarkdown("**where I belong**")
        let font = try renderedFont(from: rendered)
        let weight = try XCTUnwrap(weightAxis(for: font))

        XCTAssertFalse(hasUnresolvedEmphasis)
        XCTAssertEqual(familyName(for: font), "DM Sans")
        XCTAssertEqual(weight, 700, accuracy: 0.5)
        let obliqueness = renderedObliqueness(from: rendered)
        XCTAssertNil(obliqueness, "Bold-only emphasis must not apply obliqueness")
    }

    func testBoldItalicMarkdownAppliesWeightAndObliqueness() throws {
        let (rendered, hasUnresolvedEmphasis) = makeRenderedMarkdown("***ideas for something fun***")
        let font = try renderedFont(from: rendered)
        let weight = try XCTUnwrap(weightAxis(for: font))
        let obliqueness = renderedObliqueness(from: rendered)

        XCTAssertFalse(hasUnresolvedEmphasis)
        XCTAssertEqual(familyName(for: font), "DM Sans")
        XCTAssertEqual(weight, 700, accuracy: 0.5)
        XCTAssertNotNil(obliqueness)
        XCTAssertGreaterThan(abs(CGFloat(truncating: obliqueness!)), 0.01)
    }

    func testItalicEmojiHasNoObliqueness() throws {
        let input = "*harder than the 🥺 did*"
        let (rendered, hasUnresolvedEmphasis) = makeRenderedMarkdown(input)
        XCTAssertFalse(hasUnresolvedEmphasis)

        // Surrounding italic text keeps obliqueness.
        let textObliqueness = rendered.attribute(.obliqueness, at: 0, effectiveRange: nil) as? NSNumber
        XCTAssertNotNil(textObliqueness)
        XCTAssertGreaterThan(abs(CGFloat(truncating: try XCTUnwrap(textObliqueness))), 0.01)

        // The emoji grapheme cluster has obliqueness stripped.
        let emojiOffset = try XCTUnwrap(utf16Offset(of: "🥺", in: rendered.string))
        let emojiObliqueness = rendered.attribute(.obliqueness, at: emojiOffset, effectiveRange: nil) as? NSNumber
        if let emojiObliqueness {
            XCTAssertLessThan(abs(CGFloat(truncating: emojiObliqueness)), 0.01, "Emoji inside italic runs must not be skewed")
        }
    }

    func testBoldItalicEmojiHasNoObliqueness() throws {
        let input = "***oof 🥺***"
        let (rendered, hasUnresolvedEmphasis) = makeRenderedMarkdown(input)
        XCTAssertFalse(hasUnresolvedEmphasis)

        let textObliqueness = rendered.attribute(.obliqueness, at: 0, effectiveRange: nil) as? NSNumber
        XCTAssertNotNil(textObliqueness)
        XCTAssertGreaterThan(abs(CGFloat(truncating: try XCTUnwrap(textObliqueness))), 0.01)

        let emojiOffset = try XCTUnwrap(utf16Offset(of: "🥺", in: rendered.string))
        let emojiObliqueness = rendered.attribute(.obliqueness, at: emojiOffset, effectiveRange: nil) as? NSNumber
        if let emojiObliqueness {
            XCTAssertLessThan(abs(CGFloat(truncating: emojiObliqueness)), 0.01)
        }
    }

    func testCompoundZWJEmojiHasNoObliqueness() throws {
        // Family emoji is a multi-scalar ZWJ sequence — must be treated as one
        // grapheme cluster so obliqueness is stripped across the whole sequence.
        let input = "*family 👨‍👩‍👧 time*"
        let (rendered, hasUnresolvedEmphasis) = makeRenderedMarkdown(input)
        XCTAssertFalse(hasUnresolvedEmphasis)

        let emojiOffset = try XCTUnwrap(utf16Offset(of: "👨\u{200D}👩\u{200D}👧", in: rendered.string))
        let emojiObliqueness = rendered.attribute(.obliqueness, at: emojiOffset, effectiveRange: nil) as? NSNumber
        if let emojiObliqueness {
            XCTAssertLessThan(abs(CGFloat(truncating: emojiObliqueness)), 0.01)
        }
    }

    func testTextPresentationDigitKeepsObliqueness() throws {
        // Digits have the Emoji property but not Emoji_Presentation, and no VS16.
        // They must remain italicized inside an italic run.
        let input = "*round 1 ends*"
        let (rendered, hasUnresolvedEmphasis) = makeRenderedMarkdown(input)
        XCTAssertFalse(hasUnresolvedEmphasis)

        let digitOffset = try XCTUnwrap(utf16Offset(of: "1", in: rendered.string))
        let digitObliqueness = rendered.attribute(.obliqueness, at: digitOffset, effectiveRange: nil) as? NSNumber
        XCTAssertNotNil(digitObliqueness, "Text-presentation digits must keep italic obliqueness")
        XCTAssertGreaterThan(abs(CGFloat(truncating: try XCTUnwrap(digitObliqueness))), 0.01)
    }

    func testNonItalicEmojiRendersWithoutObliqueness() throws {
        // Sanity check: when nothing applied obliqueness, the strip pass is a no-op.
        let (rendered, _) = makeRenderedMarkdown("plain 🥺 text")
        let emojiOffset = try XCTUnwrap(utf16Offset(of: "🥺", in: rendered.string))
        let emojiObliqueness = rendered.attribute(.obliqueness, at: emojiOffset, effectiveRange: nil) as? NSNumber
        XCTAssertNil(emojiObliqueness)
    }

    func testInvalidEmphasisFontsSkipMeasurementCaching() throws {
        #if DEBUG
        VFont._chatMarkdownFontSetOverride = { size in
            let regular = NSFont.systemFont(ofSize: size)
            let bold = NSFont.boldSystemFont(ofSize: size)
            let italic = NSFontManager.shared.convert(regular, toHaveTrait: .italicFontMask)
            let boldItalic = NSFontManager.shared.convert(bold, toHaveTrait: .italicFontMask)
            return VFont.ChatMarkdownFontSet(
                regular: regular,
                bold: bold,
                italic: italic,
                boldItalic: boldItalic,
                regularIsResolved: false,
                boldIsResolved: false,
                italicIsResolved: false,
                boldItalicIsResolved: false,
                isResolved: false,
                diagnosticPostScriptNames: [
                    "regular": regular.fontName,
                    "bold": bold.fontName,
                    "italic": italic.fontName,
                    "boldItalic": boldItalic.fontName,
                ]
            )
        }
        #endif

        let source = try makeAttributedString(from: "*italics disappear*")
        let (_, hasUnresolvedEmphasis) = MarkdownSegmentView.convertToNSAttributedString(
            source,
            fontSet: VFont.resolvedChatMarkdownFontSet(),
            textColor: .labelColor
        )
        XCTAssertTrue(hasUnresolvedEmphasis)

        let segments = parseMarkdownSegments("*italics disappear*")
        let view = MarkdownSegmentView(segments: segments)
        _ = view.resolveSelectableRunMeasurement(segments)

        XCTAssertEqual(
            MarkdownSegmentView._measuredTextCacheInsertCount,
            0,
            "Unresolved emphasis must not be inserted into the measured text cache"
        )
    }

    /// `bubbleMaxWidth` is 0 during the first LazyVStack pass, before the
    /// chat column's width resolves. A collapsed measurement must NOT be
    /// cached at either the `measuredTextCache` or
    /// `VSelectableTextView.measurementSizeCache` layer — caching (0,0)
    /// would leave the cell stacked under its neighbor and cause the
    /// multi-message overlap seen in practice.
    func testZeroWidthReturnsZeroSizeWithoutPoisoningCaches() {
        let segments = parseMarkdownSegments("a long enough run of text to wrap")
        let view = MarkdownSegmentView(segments: segments, maxContentWidth: 0)
        let result = view.resolveSelectableRunMeasurementResult(segments)

        XCTAssertEqual(result.size.height, 0)
        XCTAssertEqual(
            MarkdownSegmentView._measuredTextCacheInsertCount,
            0,
            "Zero-height measurement must not populate the measured text cache"
        )

        // Now re-measure at a real width. Because nothing poisoned the
        // caches, this must produce a non-zero height and populate the
        // measured text cache exactly once.
        let resolvedView = MarkdownSegmentView(
            segments: segments,
            maxContentWidth: VSpacing.chatBubbleMaxWidth
        )
        let resolved = resolvedView.resolveSelectableRunMeasurementResult(segments)
        XCTAssertGreaterThan(resolved.size.height, 0)
        XCTAssertEqual(MarkdownSegmentView._measuredTextCacheInsertCount, 1)
    }

    func testWarmupRefreshClearsRenderCachesAndForcesRebuild() {
        let segments = parseMarkdownSegments("*warmup cache reset*")
        let key = "*warmup cache reset*" as NSString
        let view = MarkdownSegmentView(segments: segments)

        ChatBubble.segmentCache.setObject(SegmentCacheEntry(segments), forKey: key)
        ChatBubble.lastStreamingSegments = (text: key as String, value: segments)
        ChatBubble.lastStreamingParseTime = 42

        _ = view.resolveSelectableRunMeasurement(segments)
        XCTAssertEqual(MarkdownSegmentView._measuredTextCacheInsertCount, 1)

        let generationBefore = VFont.typographyGeneration
        FontWarmupCoordinator.shared.refreshTypographyStateForReadyFonts()

        XCTAssertEqual(VFont.typographyGeneration, generationBefore + 1)
        XCTAssertNil(ChatBubble.segmentCache.object(forKey: key))
        XCTAssertNil(ChatBubble.lastStreamingSegments)
        XCTAssertEqual(ChatBubble.lastStreamingParseTime, 0)
        XCTAssertEqual(MarkdownSegmentView._measuredTextCacheInsertCount, 0)

        _ = view.resolveSelectableRunMeasurement(segments)
        XCTAssertEqual(
            MarkdownSegmentView._measuredTextCacheInsertCount,
            1,
            "A typography generation bump must force the next measurement to rebuild"
        )
    }

    func testUnresolvedEmphasisSchedulesTypographyRetryAndRecovers() async {
        #if DEBUG
        var resolutionAttempt = 0
        VFont._chatMarkdownFontSetOverride = { size in
            resolutionAttempt += 1
            if resolutionAttempt == 1 {
                return self.invalidFontSet(size: size)
            }
            return self.validFontSet(size: size)
        }
        #endif

        let segments = parseMarkdownSegments("*bell jingles*")
        let view = MarkdownSegmentView(segments: segments)
        let generationBefore = VFont.typographyGeneration

        let firstResult = view.resolveSelectableRunMeasurementResult(segments)
        XCTAssertTrue(firstResult.hasUnresolvedEmphasis)
        XCTAssertEqual(MarkdownSegmentView._measuredTextCacheInsertCount, 0)

        try? await Task.sleep(nanoseconds: 200_000_000)

        XCTAssertGreaterThanOrEqual(
            VFont.typographyGeneration,
            generationBefore + 1,
            "Unresolved emphasis should schedule at least one typography refresh retry"
        )

        let secondResult = view.resolveSelectableRunMeasurementResult(
            segments,
            typographyGeneration: VFont.typographyGeneration
        )
        let font = try? renderedFont(from: secondResult.nsAttributedString)
        let obliqueness = renderedObliqueness(from: secondResult.nsAttributedString)

        XCTAssertFalse(secondResult.hasUnresolvedEmphasis)
        XCTAssertEqual(MarkdownSegmentView._measuredTextCacheInsertCount, 1)
        XCTAssertEqual(font.map(familyName(for:)), "DM Sans")
        XCTAssertNotNil(obliqueness, "Italic emphasis should set obliqueness once fonts resolve")
        XCTAssertGreaterThan(abs(CGFloat(truncating: try XCTUnwrap(obliqueness))), 0.01)
    }

    func testHeadingFontSurvivesConversionPipeline() throws {
        let segments = parseMarkdownSegments("## Heading\n\nBody text")
        let view = MarkdownSegmentView(segments: segments)
        let result = view.resolveSelectableRunMeasurementResult(segments)

        let headingFont = try XCTUnwrap(
            result.nsAttributedString.attribute(.font, at: 0, effectiveRange: nil) as? NSFont
        )
        XCTAssertEqual(familyName(for: headingFont), "DM Sans")
        let weight = try XCTUnwrap(weightAxis(for: headingFont))
        XCTAssertEqual(weight, 600, accuracy: 0.5, "h2 heading should use weight 600")
        XCTAssertEqual(headingFont.pointSize, 16, "h2 heading should be 16pt")
    }

    func testTypographyGenerationBumpInvalidatesAttributedStringCache() {
        let segments = parseMarkdownSegments("## Heading\n\nBody text")
        let view = MarkdownSegmentView(segments: segments)

        // First measurement populates both caches.
        _ = view.resolveSelectableRunMeasurementResult(segments)
        XCTAssertEqual(
            MarkdownSegmentView._attributedStringBuildCount, 1,
            "First call must build the AttributedString (cache miss)"
        )

        // Same generation — attributedStringCache should hit.
        _ = view.resolveSelectableRunMeasurementResult(segments)
        XCTAssertEqual(
            MarkdownSegmentView._attributedStringBuildCount, 1,
            "Second call at the same generation must serve from attributedStringCache"
        )

        // Bump typography generation (simulates scheduleTypographyRetryIfNeeded
        // firing after DM Sans loads, without clearing attributedStringCache).
        VFont.bumpTypographyGeneration()

        // After bump, attributedStringCache must miss so heading fonts are
        // rebuilt with the updated typography state.
        _ = view.resolveSelectableRunMeasurementResult(segments)
        XCTAssertEqual(
            MarkdownSegmentView._attributedStringBuildCount, 2,
            "A typography generation bump must cause an attributedStringCache miss"
        )
    }

    // MARK: - Block Math (`$$…$$`) Parsing

    func testBlockMath_singleLine() {
        let segments = parseMarkdownSegments("$$x^2$$")
        XCTAssertEqual(segments, [.math(latex: "x^2", display: true)])
    }

    func testBlockMath_multiLine() {
        let segments = parseMarkdownSegments("$$\n\\frac{a}{b}\n$$")
        XCTAssertEqual(segments, [.math(latex: "\\frac{a}{b}", display: true)])
    }

    /// Regression test for the original report that motivated this feature —
    /// LaTeX pasted into a single-line `$$…$$` wrapper must emit exactly one
    /// `.math` segment whose payload is the raw inner expression.
    func testBlockMath_screenshotRegression() {
        let input = "$$m_\\text{ferrite} \\propto (\\text{ferrite thickness}) "
            + "\\propto \\frac{F_\\text{required}}{F_\\text{available per m}} "
            + "\\propto \\frac{1}{\\text{margin}}$$"
        let expectedInner = "m_\\text{ferrite} \\propto (\\text{ferrite thickness}) "
            + "\\propto \\frac{F_\\text{required}}{F_\\text{available per m}} "
            + "\\propto \\frac{1}{\\text{margin}}"

        let segments = parseMarkdownSegments(input)
        XCTAssertEqual(segments.count, 1)
        guard case .math(let latex, let display) = segments.first else {
            return XCTFail("Expected .math segment, got \(segments)")
        }
        XCTAssertEqual(latex, expectedInner)
        XCTAssertTrue(display)
    }

    func testBlockMath_insideCodeBlockIsPreserved() {
        let segments = parseMarkdownSegments("```\n$$x^2$$\n```")
        XCTAssertEqual(segments, [.codeBlock(language: nil, code: "$$x^2$$")])
    }

    func testBlockMath_unclosedFallsBackToText() {
        let segments = parseMarkdownSegments("$$\nx^2")
        XCTAssertEqual(segments.count, 1)
        guard case .text(let content) = segments.first else {
            return XCTFail("Expected .text segment for unclosed $$, got \(segments)")
        }
        // Unclosed block-math reverts to plain text — the `$$` opener and any
        // collected lines must both survive (though outer whitespace is
        // trimmed by flushText). No `.math` segment should be emitted.
        XCTAssertTrue(content.contains("$$"), "Unclosed `$$` opener must appear verbatim in the text; got: \(content)")
        XCTAssertTrue(content.contains("x^2"), "Content after the unclosed opener must survive; got: \(content)")
        for segment in segments {
            if case .math = segment {
                XCTFail("Unclosed `$$` must not emit a .math segment")
            }
        }
    }

    /// Regression: during streaming, we see `before\n$$\n<partial>` before the
    /// closing `$$` arrives. The parser must not emit the prefix prose and
    /// the verbatim fallback as two separate `.text` segments — the renderer
    /// joins adjacent text with a blank line, producing a visible flicker
    /// each streaming tick until the close arrives.
    func testBlockMath_unclosedWithPrecedingProseStaysOneTextSegment() {
        let segments = parseMarkdownSegments("before\n$$\nx^2")
        var textSegments = 0
        for segment in segments {
            if case .text = segment { textSegments += 1 }
            if case .math = segment {
                XCTFail("Unclosed `$$` must not emit a .math segment")
            }
        }
        XCTAssertEqual(textSegments, 1, "Verbatim fallback must flush as a single .text segment; got \(segments)")
        guard case .text(let content) = segments.first else {
            return XCTFail("Expected a .text segment, got \(segments)")
        }
        XCTAssertTrue(content.contains("before"))
        XCTAssertTrue(content.contains("$$"))
        XCTAssertTrue(content.contains("x^2"))
    }

    func testBlockMath_emptyDelimitersAreText() {
        let segments = parseMarkdownSegments("$$$$")
        XCTAssertEqual(segments, [.text("$$$$")])
    }

    func testBlockMath_twoBackToBack() {
        let segments = parseMarkdownSegments("$$a$$\n\n$$b$$")
        XCTAssertEqual(segments, [
            .math(latex: "a", display: true),
            .math(latex: "b", display: true),
        ])
    }

    func testBlockMath_mixedWithProse() {
        let segments = parseMarkdownSegments("Here is math:\n\n$$x^2$$\n\nEnd.")
        XCTAssertEqual(segments, [
            .text("Here is math:"),
            .math(latex: "x^2", display: true),
            .text("End."),
        ])
    }

    /// Pins the current parser behavior for prose that contains `$` signs —
    /// no `.math` segment should be emitted. This protects against silent
    /// regressions when inline-math (`$…$`) support lands in the future; any
    /// new inline-math parser must still leave price-like prose alone.
    func testProse_withDollarSigns_isNotMisparsedAsMath() {
        let inputs = [
            "Prices: $10 and $20",
            "$price: $10 vs $15$",
            "Spent $5 on coffee.",
            "Net of $3.50 after fees.",
            "One $ left.",
        ]
        for input in inputs {
            let segments = parseMarkdownSegments(input)
            for segment in segments {
                if case .math = segment {
                    XCTFail("Prose with `$` must not emit a .math segment. Input=\(input), got=\(segments)")
                }
            }
            // Every prose input above should collapse into a single .text
            // segment — pin that too so future refactors don't silently
            // split prose across multiple segments.
            XCTAssertEqual(segments.count, 1, "Expected a single .text segment for input=\(input), got \(segments)")
            if case .text(let text)? = segments.first {
                XCTAssertEqual(text, input, "Prose must round-trip verbatim")
            } else {
                XCTFail("Expected first segment to be .text for input=\(input), got \(segments)")
            }
        }
    }

    private func makeRenderedMarkdown(_ markdown: String) -> (NSAttributedString, Bool) {
        let source = (try? makeAttributedString(from: markdown)) ?? AttributedString(markdown)
        return MarkdownSegmentView.convertToNSAttributedString(
            source,
            fontSet: VFont.resolvedChatMarkdownFontSet(),
            textColor: .labelColor
        )
    }

    private func makeAttributedString(from markdown: String) throws -> AttributedString {
        try AttributedString(markdown: markdown, options: Self.markdownOptions)
    }

    private func renderedFont(from rendered: NSAttributedString) throws -> NSFont {
        let font = rendered.attribute(.font, at: 0, effectiveRange: nil) as? NSFont
        return try XCTUnwrap(font)
    }

    private func renderedObliqueness(from rendered: NSAttributedString) -> NSNumber? {
        rendered.attribute(.obliqueness, at: 0, effectiveRange: nil) as? NSNumber
    }

    private func utf16Offset(of needle: String, in haystack: String) -> Int? {
        guard let range = haystack.range(of: needle) else { return nil }
        return haystack.utf16.distance(from: haystack.utf16.startIndex, to: range.lowerBound.samePosition(in: haystack.utf16)!)
    }

    private func familyName(for font: NSFont) -> String {
        CTFontCopyFamilyName(font as CTFont) as String
    }

    private func weightAxis(for font: NSFont) -> CGFloat? {
        guard let variations = CTFontCopyVariation(font as CTFont) as? [NSNumber: NSNumber],
              let value = variations[0x77676874 as NSNumber] else {
            return nil
        }
        return CGFloat(truncating: value)
    }

    private func validFontSet(size: CGFloat) -> VFont.ChatMarkdownFontSet {
        let regular = VFont.resolvedDMSansFont(weight: 400, size: size)
        let bold = VFont.resolvedDMSansFont(weight: 700, size: size)
        let italic = VFont.resolvedDMSansFont(weight: 400, size: size)
        let boldItalic = VFont.resolvedDMSansFont(weight: 700, size: size)
        return VFont.ChatMarkdownFontSet(
            regular: regular,
            bold: bold,
            italic: italic,
            boldItalic: boldItalic,
            regularIsResolved: true,
            boldIsResolved: true,
            italicIsResolved: true,
            boldItalicIsResolved: true,
            isResolved: true,
            diagnosticPostScriptNames: [
                "regular": regular.fontName,
                "bold": bold.fontName,
                "italic": italic.fontName,
                "boldItalic": boldItalic.fontName,
            ]
        )
    }

    private func invalidFontSet(size: CGFloat) -> VFont.ChatMarkdownFontSet {
        let regular = NSFont.systemFont(ofSize: size)
        let bold = NSFont.boldSystemFont(ofSize: size)
        let italic = NSFontManager.shared.convert(regular, toHaveTrait: .italicFontMask)
        let boldItalic = NSFontManager.shared.convert(bold, toHaveTrait: .italicFontMask)
        return VFont.ChatMarkdownFontSet(
            regular: regular,
            bold: bold,
            italic: italic,
            boldItalic: boldItalic,
            regularIsResolved: false,
            boldIsResolved: false,
            italicIsResolved: false,
            boldItalicIsResolved: false,
            isResolved: false,
            diagnosticPostScriptNames: [
                "regular": regular.fontName,
                "bold": bold.fontName,
                "italic": italic.fontName,
                "boldItalic": boldItalic.fontName,
            ]
        )
    }

    private static func registerTestFonts() {
        let fontsDirectory = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("vellum-assistant/Resources/Fonts", isDirectory: true)

        for name in [
            "DMMono-Regular",
            "DMMono-Medium",
            "DMSans-Regular",
            "DMSans-Medium",
            "DMSans-SemiBold",
            "InstrumentSerif-Regular",
        ] {
            var error: Unmanaged<CFError>?
            _ = CTFontManagerRegisterFontsForURL(
                fontsDirectory.appendingPathComponent("\(name).ttf") as CFURL,
                .process,
                &error
            )
        }
    }

    // MARK: - SwiftMath

    #if canImport(SwiftMath)
    func testMathImage_rendersScreenshotLatex() {
        let latex = #"m_\text{ferrite} \propto (\text{ferrite thickness}) \propto \frac{F_\text{required}}{F_\text{available per m}} \propto \frac{1}{\text{margin}}"#
        var math = MathImage(latex: latex, fontSize: 13, textColor: NSColor.black, labelMode: .display)
        let (error, image) = math.asImage()
        XCTAssertNil(error, "SwiftMath rejected the screenshot LaTeX: \(error.map { String(describing: $0) } ?? "unknown")")
        XCTAssertNotNil(image)
        XCTAssertGreaterThan(image?.size.width ?? 0, 0)
        XCTAssertGreaterThan(image?.size.height ?? 0, 0)
    }
    #endif
}
