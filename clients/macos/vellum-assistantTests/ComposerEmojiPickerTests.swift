#if os(macOS)
import XCTest
@testable import VellumAssistantLib
import VellumAssistantShared

final class ComposerEmojiPickerTests: XCTestCase {

    func testEmojiCatalogSearchReturnsResultsForCommonPrefixes() {
        let results = EmojiCatalog.search(prefix: "thu")
        XCTAssertFalse(results.isEmpty, "Expected results for prefix 'thu'")
        for entry in results {
            XCTAssertTrue(
                entry.shortcode.hasPrefix("thu"),
                "Expected shortcode '\(entry.shortcode)' to start with 'thu'"
            )
        }
    }

    func testEmojiCatalogSearchCapsAtEightByDefault() {
        let results = EmojiCatalog.search(prefix: "s")
        XCTAssertLessThanOrEqual(results.count, 8, "Default limit should cap results at 8")
    }

    func testEmojiPickerRowRendersEmojiAndShortcode() {
        let entry = EmojiEntry(shortcode: "thumbsup", emoji: "\u{1F44D}")
        let row = EmojiPickerRow(
            entry: entry,
            isSelected: false,
            onSelect: {}
        )
        // Verify the view can be instantiated without errors
        XCTAssertNotNil(row)
        XCTAssertEqual(row.entry.shortcode, "thumbsup")
        XCTAssertEqual(row.entry.emoji, "\u{1F44D}")
    }
}
#endif
