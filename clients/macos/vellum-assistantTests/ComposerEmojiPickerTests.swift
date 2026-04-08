#if os(macOS)
import XCTest
@testable import VellumAssistantLib
@preconcurrency import VellumAssistantShared

final class ComposerEmojiPickerTests: XCTestCase {

    func testEmojiCatalogSearchReturnsSubstringMatches() {
        let results = EmojiCatalog.search(query: "eart")
        XCTAssertFalse(results.isEmpty, "Expected results for substring 'eart'")
        for entry in results {
            XCTAssertTrue(
                entry.shortcode.contains("eart"),
                "Expected shortcode '\(entry.shortcode)' to contain 'eart'"
            )
        }
    }

    func testEmojiCatalogSearchCapsAtEightByDefault() {
        let results = EmojiCatalog.search(query: "s")
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

    // MARK: - Controller-backed emoji popup regression tests

    /// Verifies the controller-driven emoji popup opens with the expected
    /// filter when a colon trigger is typed, matching the behavior that
    /// was previously owned by ComposerView body callbacks.
    @MainActor
    func testControllerDrivenEmojiPopupOpensOnColonTrigger() {
        let controller = ComposerController(
            emojiSearchProvider: StubEmojiProvider(entries: [
                EmojiEntry(shortcode: "thumbsup", emoji: "\u{1F44D}"),
                EmojiEntry(shortcode: "thumbsdown", emoji: "\u{1F44E}"),
            ])
        )

        let text = "hello :th"
        controller.textChanged(text)
        controller.cursorMoved(to: text.utf16.count)
        controller.performMenuRefresh()

        XCTAssertTrue(controller.showEmojiMenu,
                      "Controller should open emoji menu on valid colon trigger")
        XCTAssertEqual(controller.emojiFilter, "th")
        XCTAssertEqual(controller.emojiSelectedIndex, 0)
    }

    /// Verifies that selecting an emoji via the controller returns the entry
    /// and closes the menu, matching the old view-owned select behavior.
    @MainActor
    func testControllerDrivenEmojiSelectClosesMenu() {
        let controller = ComposerController(
            emojiSearchProvider: StubEmojiProvider(entries: [
                EmojiEntry(shortcode: "heart", emoji: "\u{2764}\u{FE0F}"),
                EmojiEntry(shortcode: "heartbreak", emoji: "\u{1F494}"),
            ])
        )

        let text = ":heart"
        controller.textChanged(text)
        controller.cursorMoved(to: text.utf16.count)
        controller.performMenuRefresh()
        XCTAssertTrue(controller.showEmojiMenu)

        let entry = controller.handleEmojiNavigation(.select)
        XCTAssertNotNil(entry, "Select should return the highlighted entry")
        XCTAssertEqual(entry?.shortcode, "heart")
        XCTAssertFalse(controller.showEmojiMenu,
                       "Menu should close after selection")
    }

    /// Regression: dismissing the emoji popup via escape must set the
    /// suppress-reopen flag so the next text change doesn't reopen it.
    @MainActor
    func testControllerDrivenEmojiDismissSuppressesReopen() {
        let controller = ComposerController(
            emojiSearchProvider: StubEmojiProvider(entries: [
                EmojiEntry(shortcode: "fire", emoji: "\u{1F525}"),
            ])
        )

        let text = ":fire"
        controller.textChanged(text)
        controller.cursorMoved(to: text.utf16.count)
        controller.performMenuRefresh()
        XCTAssertTrue(controller.showEmojiMenu)

        controller.handleEmojiNavigation(.dismiss)
        XCTAssertFalse(controller.showEmojiMenu)
        XCTAssertTrue(controller.suppressEmojiReopen,
                      "Dismiss should set suppress flag to prevent immediate reopen")

        // Next refresh consumes the flag and keeps the menu closed
        controller.textChanged(text)
        controller.cursorMoved(to: text.utf16.count)
        controller.performMenuRefresh()
        XCTAssertFalse(controller.showEmojiMenu,
                       "Menu should stay closed during suppressed cycle")
        XCTAssertFalse(controller.suppressEmojiReopen,
                       "Suppress flag should be consumed after one cycle")
    }
}

// MARK: - Test Helpers

/// Minimal emoji search provider for controller-backed popup tests.
private struct StubEmojiProvider: EmojiSearchProvider {
    let entries: [EmojiEntry]

    func search(query: String, limit: Int) -> [EmojiEntry] {
        let matched = entries.filter { $0.shortcode.contains(query.lowercased()) }
        return Array(matched.prefix(limit))
    }
}
#endif
