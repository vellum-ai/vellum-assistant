import XCTest
@testable import VellumAssistantShared

final class EmojiCatalogTests: XCTestCase {

    func testCatalogIsNotEmpty() {
        XCTAssertGreaterThan(EmojiCatalog.all.count, 100)
    }

    func testCatalogIsSortedByShortcode() {
        let shortcodes = EmojiCatalog.all.map(\.shortcode)
        for i in 1..<shortcodes.count {
            XCTAssertLessThanOrEqual(
                shortcodes[i - 1], shortcodes[i],
                "Catalog not sorted: \(shortcodes[i - 1]) should come before \(shortcodes[i])"
            )
        }
    }

    func testNoDuplicateShortcodes() {
        let shortcodes = EmojiCatalog.all.map(\.shortcode)
        XCTAssertEqual(Set(shortcodes).count, shortcodes.count, "Duplicate shortcodes found in catalog")
    }

    func testShortcodesContainNoColons() {
        for entry in EmojiCatalog.all {
            XCTAssertFalse(entry.shortcode.contains(":"), "Shortcode '\(entry.shortcode)' contains a colon")
        }
    }

    func testSearchPrefixMatch() {
        let results = EmojiCatalog.search(prefix: "thu")
        XCTAssertFalse(results.isEmpty, "Expected results for prefix 'thu'")
        for entry in results {
            XCTAssertTrue(
                entry.shortcode.hasPrefix("thu"),
                "Entry '\(entry.shortcode)' does not start with 'thu'"
            )
        }
    }

    func testSearchIsCaseInsensitive() {
        let lower = EmojiCatalog.search(prefix: "thu")
        let upper = EmojiCatalog.search(prefix: "THU")
        XCTAssertEqual(lower, upper, "Case-insensitive search should return identical results")
    }

    func testSearchRespectsLimit() {
        let results = EmojiCatalog.search(prefix: "", limit: 3)
        XCTAssertLessThanOrEqual(results.count, 3)
    }

    func testCommonShortcodesExist() {
        let required = ["thumbsup", "heart", "fire", "rocket", "tada", "wave", "smile", "eyes", "pray", "100", "poop", "punch", "plus", "minus"]
        let allShortcodes = Set(EmojiCatalog.all.map(\.shortcode))
        for code in required {
            XCTAssertTrue(allShortcodes.contains(code), "Common shortcode '\(code)' missing from catalog")
        }
    }
}
