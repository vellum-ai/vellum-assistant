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

    func testSearchSubstringMatch() {
        let results = EmojiCatalog.search(query: "eart")
        XCTAssertFalse(results.isEmpty, "Expected results for substring 'eart'")
        for entry in results {
            XCTAssertTrue(
                entry.shortcode.contains("eart"),
                "Entry '\(entry.shortcode)' does not contain 'eart'"
            )
        }
    }

    func testSearchPrefixMatchesRankedFirst() {
        let results = EmojiCatalog.search(query: "hear", limit: 20)
        // "heart" variants start with "hear" and should appear before substring-only matches like "hear_no_evil" is actually a prefix too
        // Find first non-prefix match index
        var lastPrefixIndex = -1
        var firstSubstringIndex = Int.max
        for (i, entry) in results.enumerated() {
            if entry.shortcode.hasPrefix("hear") {
                lastPrefixIndex = i
            } else if entry.shortcode.contains("hear") && firstSubstringIndex == Int.max {
                firstSubstringIndex = i
            }
        }
        if lastPrefixIndex >= 0 && firstSubstringIndex < Int.max {
            XCTAssertLessThan(lastPrefixIndex, firstSubstringIndex,
                "Prefix matches should appear before substring-only matches")
        }
    }

    func testSearchIsCaseInsensitive() {
        let lower = EmojiCatalog.search(query: "thu")
        let upper = EmojiCatalog.search(query: "THU")
        XCTAssertEqual(lower, upper, "Case-insensitive search should return identical results")
    }

    func testSearchRespectsLimit() {
        let results = EmojiCatalog.search(query: "", limit: 3)
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
