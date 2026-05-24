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

    func testAliasNeverIncludesOwnShortcode() {
        for entry in EmojiCatalog.all {
            XCTAssertFalse(
                entry.aliases.contains(entry.shortcode),
                "Entry '\(entry.shortcode)' lists its own shortcode in aliases"
            )
        }
    }

    func testAliasesAreUniquePerEntry() {
        for entry in EmojiCatalog.all where !entry.aliases.isEmpty {
            XCTAssertEqual(
                Set(entry.aliases).count, entry.aliases.count,
                "Entry '\(entry.shortcode)' has duplicate aliases: \(entry.aliases)"
            )
        }
    }

    func testSearchSurfacesEmojiViaAlias() {
        // 😤's shortcode is "triumph" but users type :huff / :frustrated / :steam.
        let huff = EmojiCatalog.search(query: "huff", limit: 8)
        XCTAssertTrue(
            huff.contains(where: { $0.emoji == "\u{1F624}" }),
            "Expected 😤 in results for :huff, got \(huff.map(\.shortcode))"
        )
        let frustrated = EmojiCatalog.search(query: "frustrated", limit: 8)
        XCTAssertTrue(
            frustrated.contains(where: { $0.emoji == "\u{1F624}" }),
            "Expected 😤 in results for :frustrated, got \(frustrated.map(\.shortcode))"
        )
    }

    func testShortcodeMatchOutranksAliasMatch() {
        // :steam should rank steam_locomotive (shortcode prefix) above triumph (alias only).
        let results = EmojiCatalog.search(query: "steam", limit: 20)
        guard let locoIdx = results.firstIndex(where: { $0.shortcode == "steam_locomotive" }),
              let triumphIdx = results.firstIndex(where: { $0.shortcode == "triumph" })
        else {
            XCTFail("Expected both steam_locomotive and triumph in :steam results")
            return
        }
        XCTAssertLessThan(locoIdx, triumphIdx, "Shortcode prefix match should rank above alias match")
    }

    func testSearchDedupesByShortcode() {
        let results = EmojiCatalog.search(query: "heart", limit: 50)
        let shortcodes = results.map(\.shortcode)
        XCTAssertEqual(Set(shortcodes).count, shortcodes.count, "Search returned duplicate shortcodes")
    }

    func testTriumphHasExpectedAliases() {
        guard let triumph = EmojiCatalog.all.first(where: { $0.shortcode == "triumph" }) else {
            XCTFail("Expected 'triumph' entry in catalog")
            return
        }
        for expected in ["huff", "frustrated", "fed_up"] {
            XCTAssertTrue(triumph.aliases.contains(expected),
                          "Expected 'triumph' aliases to include '\(expected)', got \(triumph.aliases)")
        }
    }
}
