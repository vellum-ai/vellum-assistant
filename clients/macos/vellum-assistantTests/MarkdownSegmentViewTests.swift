import AppKit
import CoreText
import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

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

    func testItalicMarkdownUsesObliqueDMSansFont() throws {
        let (rendered, hasUnresolvedEmphasis) = makeRenderedMarkdown("*settles in*")
        let font = try renderedFont(from: rendered)

        XCTAssertFalse(hasUnresolvedEmphasis)
        XCTAssertEqual(familyName(for: font), "DM Sans")
        XCTAssertGreaterThan(abs(CTFontGetMatrix(font as CTFont).c), 0.0001)
    }

    func testBoldMarkdownUsesWeightedDMSansFont() throws {
        let (rendered, hasUnresolvedEmphasis) = makeRenderedMarkdown("**where I belong**")
        let font = try renderedFont(from: rendered)
        let weight = try XCTUnwrap(weightAxis(for: font))

        XCTAssertFalse(hasUnresolvedEmphasis)
        XCTAssertEqual(familyName(for: font), "DM Sans")
        XCTAssertEqual(weight, 700, accuracy: 0.5)
        XCTAssertEqual(CTFontGetMatrix(font as CTFont).c, 0, accuracy: 0.0001)
    }

    func testBoldItalicMarkdownUsesWeightedObliqueDMSansFont() throws {
        let (rendered, hasUnresolvedEmphasis) = makeRenderedMarkdown("***ideas for something fun***")
        let font = try renderedFont(from: rendered)
        let weight = try XCTUnwrap(weightAxis(for: font))

        XCTAssertFalse(hasUnresolvedEmphasis)
        XCTAssertEqual(familyName(for: font), "DM Sans")
        XCTAssertEqual(weight, 700, accuracy: 0.5)
        XCTAssertGreaterThan(abs(CTFontGetMatrix(font as CTFont).c), 0.0001)
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

        let segments = parseMarkdownSegments("*collar jingles*")
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

        XCTAssertFalse(secondResult.hasUnresolvedEmphasis)
        XCTAssertEqual(MarkdownSegmentView._measuredTextCacheInsertCount, 1)
        XCTAssertEqual(font.map(familyName(for:)), "DM Sans")
        XCTAssertGreaterThan(abs(CTFontGetMatrix((try XCTUnwrap(font)) as CTFont).c), 0.0001)
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
        let italic = VFont.resolvedDMSansFont(weight: 400, size: size, obliqueDegrees: 12)
        let boldItalic = VFont.resolvedDMSansFont(weight: 700, size: size, obliqueDegrees: 12)
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
}
