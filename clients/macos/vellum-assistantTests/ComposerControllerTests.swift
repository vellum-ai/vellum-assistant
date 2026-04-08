#if os(macOS)
import XCTest
@testable import VellumAssistantLib
@preconcurrency import VellumAssistantShared

// MARK: - Test Helpers

/// Stub slash command provider with a fixed set of commands.
private struct StubSlashCommandProvider: SlashCommandProvider {
    let commands: [SlashCommand]

    func filteredCommands(_ filter: String) -> [SlashCommand] {
        commands.filter {
            filter.isEmpty || $0.name.lowercased().hasPrefix(filter.lowercased())
        }
    }
}

/// Stub emoji search provider that returns predetermined entries.
private struct StubEmojiSearchProvider: EmojiSearchProvider {
    let entries: [EmojiEntry]

    func search(query: String, limit: Int) -> [EmojiEntry] {
        let matched = entries.filter { $0.shortcode.contains(query.lowercased()) }
        return Array(matched.prefix(limit))
    }
}

/// Factory for a controller pre-loaded with predictable test data.
@MainActor
private func makeController(
    commands: [SlashCommand]? = nil,
    emojiEntries: [EmojiEntry]? = nil
) -> ComposerController {
    let defaultCommands = commands ?? [
        SlashCommand(descriptor: ChatSlashCommandDescriptor(
            name: "commands",
            description: "List all available commands",
            icon: "terminal",
            selectionBehavior: .autoSend,
            pickerPlatforms: [.macos],
            helpBubblePlatforms: [.macos],
            sendPathPlatforms: [.macos]
        )),
        SlashCommand(descriptor: ChatSlashCommandDescriptor(
            name: "compact",
            description: "Force context compaction",
            icon: "arrow.down.right.and.arrow.up.left",
            selectionBehavior: .autoSend,
            pickerPlatforms: [.macos],
            helpBubblePlatforms: [.macos],
            sendPathPlatforms: [.macos]
        )),
        SlashCommand(descriptor: ChatSlashCommandDescriptor(
            name: "btw",
            description: "Side question",
            icon: "bubble.left.and.text.bubble.right",
            selectionBehavior: .insertTrailingSpace,
            pickerPlatforms: [.macos],
            helpBubblePlatforms: [.macos],
            sendPathPlatforms: [.macos]
        )),
    ]

    let defaultEmoji = emojiEntries ?? [
        EmojiEntry(shortcode: "thumbsup", emoji: "\u{1F44D}"),
        EmojiEntry(shortcode: "thumbsdown", emoji: "\u{1F44E}"),
        EmojiEntry(shortcode: "heart", emoji: "\u{2764}\u{FE0F}"),
        EmojiEntry(shortcode: "heartbreak", emoji: "\u{1F494}"),
        EmojiEntry(shortcode: "fire", emoji: "\u{1F525}"),
        EmojiEntry(shortcode: "rocket", emoji: "\u{1F680}"),
    ]

    return ComposerController(
        slashCommandProvider: StubSlashCommandProvider(commands: defaultCommands),
        emojiSearchProvider: StubEmojiSearchProvider(entries: defaultEmoji)
    )
}

// MARK: - Tests

final class ComposerControllerTests: XCTestCase {

    // MARK: - Slash menu: basic open/close

    @MainActor
    func testSlashMenuOpensOnLeadingSlash() {
        let controller = makeController()
        controller.textChanged("/")
        controller.performMenuRefresh()

        XCTAssertTrue(controller.showSlashMenu)
        XCTAssertEqual(controller.slashFilter, "")
        XCTAssertEqual(controller.slashSelectedIndex, 0)
    }

    @MainActor
    func testSlashMenuFiltersOnTyping() {
        let controller = makeController()
        controller.textChanged("/co")
        controller.performMenuRefresh()

        XCTAssertTrue(controller.showSlashMenu)
        XCTAssertEqual(controller.slashFilter, "co")
    }

    @MainActor
    func testSlashMenuClosesWhenInputCleared() {
        let controller = makeController()

        // Open the menu
        controller.textChanged("/co")
        controller.performMenuRefresh()
        XCTAssertTrue(controller.showSlashMenu)

        // Clear input
        controller.textChanged("")
        controller.performMenuRefresh()
        XCTAssertFalse(controller.showSlashMenu)
    }

    @MainActor
    func testSlashMenuClosesWhenSpaceTyped() {
        let controller = makeController()

        controller.textChanged("/commands ")
        controller.performMenuRefresh()

        XCTAssertFalse(controller.showSlashMenu, "Space after slash command should close menu")
    }

    @MainActor
    func testSlashMenuClosesWhenNoMatchingCommands() {
        let controller = makeController()

        controller.textChanged("/zzz")
        controller.performMenuRefresh()

        XCTAssertFalse(controller.showSlashMenu, "No matching commands should close menu")
    }

    // MARK: - Slash menu: navigation

    @MainActor
    func testSlashNavigationDown() {
        let controller = makeController()
        controller.textChanged("/")
        controller.performMenuRefresh()

        controller.handleSlashNavigation(.down)
        XCTAssertEqual(controller.slashSelectedIndex, 1)

        controller.handleSlashNavigation(.down)
        XCTAssertEqual(controller.slashSelectedIndex, 2)
    }

    @MainActor
    func testSlashNavigationUpWrapsAround() {
        let controller = makeController()
        controller.textChanged("/")
        controller.performMenuRefresh()

        // At index 0, going up should wrap to last item (index 2 with 3 commands)
        controller.handleSlashNavigation(.up)
        XCTAssertEqual(controller.slashSelectedIndex, 2)
    }

    @MainActor
    func testSlashNavigationDownWrapsAround() {
        let controller = makeController()
        controller.textChanged("/")
        controller.performMenuRefresh()

        // Navigate to last item then wrap
        controller.handleSlashNavigation(.down)
        controller.handleSlashNavigation(.down)
        controller.handleSlashNavigation(.down)
        XCTAssertEqual(controller.slashSelectedIndex, 0)
    }

    @MainActor
    func testSlashNavigationSelectReturnsCommand() {
        let controller = makeController()
        controller.textChanged("/")
        controller.performMenuRefresh()

        let command = controller.handleSlashNavigation(.select)
        XCTAssertNotNil(command)
        XCTAssertEqual(command?.name, "commands")
        XCTAssertFalse(controller.showSlashMenu, "Menu should close after selection")
        XCTAssertEqual(controller.slashSelectedIndex, 0, "Selection index should reset")
    }

    @MainActor
    func testSlashNavigationDismissClosesMenu() {
        let controller = makeController()
        controller.textChanged("/")
        controller.performMenuRefresh()
        XCTAssertTrue(controller.showSlashMenu)

        controller.handleSlashNavigation(.dismiss)
        XCTAssertFalse(controller.showSlashMenu)
    }

    @MainActor
    func testSlashNavigationTabSetsSuppressReopen() {
        let controller = makeController()
        controller.textChanged("/b")
        controller.performMenuRefresh()
        XCTAssertTrue(controller.showSlashMenu)

        let command = controller.handleSlashNavigation(.tab)
        XCTAssertNotNil(command)
        XCTAssertFalse(controller.showSlashMenu, "Menu should close after tab")
        XCTAssertTrue(controller.suppressSlashReopen, "Suppress flag should be set after tab completion")
    }

    // MARK: - Slash menu: suppress reopen

    @MainActor
    func testSuppressSlashReopenSurvivesOneRefreshCycle() {
        let controller = makeController()

        // Tab-complete a command (sets suppressSlashReopen)
        controller.textChanged("/b")
        controller.performMenuRefresh()
        _ = controller.handleSlashNavigation(.tab)
        XCTAssertTrue(controller.suppressSlashReopen)

        // Simulate the text change from tab completion — suppress should consume the flag
        controller.textChanged("/btw ")
        controller.performMenuRefresh()
        XCTAssertFalse(controller.suppressSlashReopen, "Flag should be consumed after one cycle")
        XCTAssertFalse(controller.showSlashMenu, "Menu should stay closed after suppress")
    }

    // MARK: - Slash menu: selection index resets on filter change

    @MainActor
    func testSlashSelectedIndexResetsOnFilterChange() {
        let controller = makeController()
        controller.textChanged("/co")
        controller.performMenuRefresh()

        // Navigate down
        controller.handleSlashNavigation(.down)
        XCTAssertEqual(controller.slashSelectedIndex, 1)

        // Change filter — index should reset
        controller.textChanged("/b")
        controller.performMenuRefresh()
        XCTAssertEqual(controller.slashSelectedIndex, 0)
    }

    // MARK: - Emoji menu: basic open/close

    @MainActor
    func testEmojiMenuOpensOnColonWithTwoCharFilter() {
        let controller = makeController()
        let text = "hello :th"
        controller.textChanged(text)
        controller.cursorMoved(to: text.utf16.count)
        controller.performMenuRefresh()

        XCTAssertTrue(controller.showEmojiMenu)
        XCTAssertEqual(controller.emojiFilter, "th")
    }

    @MainActor
    func testEmojiMenuDoesNotOpenWithOneCharFilter() {
        let controller = makeController()
        let text = "hello :t"
        controller.textChanged(text)
        controller.cursorMoved(to: text.utf16.count)
        controller.performMenuRefresh()

        XCTAssertFalse(controller.showEmojiMenu, "Need at least 2 chars after colon")
    }

    @MainActor
    func testEmojiMenuClosesWhenInputCleared() {
        let controller = makeController()

        // Open
        let text = "hello :thu"
        controller.textChanged(text)
        controller.cursorMoved(to: text.utf16.count)
        controller.performMenuRefresh()
        XCTAssertTrue(controller.showEmojiMenu)

        // Clear
        controller.textChanged("")
        controller.cursorMoved(to: 0)
        controller.performMenuRefresh()
        XCTAssertFalse(controller.showEmojiMenu)
    }

    @MainActor
    func testEmojiMenuClosesWhenNoResults() {
        let controller = makeController()
        let text = "hello :zzzzz"
        controller.textChanged(text)
        controller.cursorMoved(to: text.utf16.count)
        controller.performMenuRefresh()

        XCTAssertFalse(controller.showEmojiMenu, "No matching emoji should close menu")
    }

    // MARK: - Emoji menu: navigation

    @MainActor
    func testEmojiNavigationDown() {
        let controller = makeController()
        let text = ":thumbs"
        controller.textChanged(text)
        controller.cursorMoved(to: text.utf16.count)
        controller.performMenuRefresh()

        controller.handleEmojiNavigation(.down)
        XCTAssertEqual(controller.emojiSelectedIndex, 1)
    }

    @MainActor
    func testEmojiNavigationUpWrapsAround() {
        let controller = makeController()
        let text = ":thumbs"
        controller.textChanged(text)
        controller.cursorMoved(to: text.utf16.count)
        controller.performMenuRefresh()

        // At index 0, going up wraps to the last matching item
        controller.handleEmojiNavigation(.up)
        // "thumbs" matches thumbsup and thumbsdown → 2 entries, wrap to index 1
        XCTAssertEqual(controller.emojiSelectedIndex, 1)
    }

    @MainActor
    func testEmojiNavigationSelectReturnsEntry() {
        let controller = makeController()
        let text = ":thumbs"
        controller.textChanged(text)
        controller.cursorMoved(to: text.utf16.count)
        controller.performMenuRefresh()

        let entry = controller.handleEmojiNavigation(.select)
        XCTAssertNotNil(entry)
        XCTAssertEqual(entry?.shortcode, "thumbsup")
        XCTAssertFalse(controller.showEmojiMenu, "Menu should close after selection")
    }

    @MainActor
    func testEmojiNavigationDismissSetsSuppressReopen() {
        let controller = makeController()
        let text = ":thumbs"
        controller.textChanged(text)
        controller.cursorMoved(to: text.utf16.count)
        controller.performMenuRefresh()
        XCTAssertTrue(controller.showEmojiMenu)

        controller.handleEmojiNavigation(.dismiss)
        XCTAssertFalse(controller.showEmojiMenu)
        XCTAssertTrue(controller.suppressEmojiReopen, "Dismiss should set suppress flag")
    }

    // MARK: - Emoji menu: suppress reopen

    @MainActor
    func testSuppressEmojiReopenSurvivesOneRefreshCycle() {
        let controller = makeController()

        // Open emoji menu
        let text = ":thumbs"
        controller.textChanged(text)
        controller.cursorMoved(to: text.utf16.count)
        controller.performMenuRefresh()
        XCTAssertTrue(controller.showEmojiMenu)

        // Dismiss (sets suppress)
        controller.handleEmojiNavigation(.dismiss)
        XCTAssertTrue(controller.suppressEmojiReopen)

        // Next refresh should consume the flag
        controller.textChanged(":thumbs")
        controller.cursorMoved(to: text.utf16.count)
        controller.performMenuRefresh()
        XCTAssertFalse(controller.suppressEmojiReopen, "Flag should be consumed")
        XCTAssertFalse(controller.showEmojiMenu, "Menu should stay closed after suppress")
    }

    // MARK: - Emoji menu: selection index resets on filter change

    @MainActor
    func testEmojiSelectedIndexResetsOnFilterChange() {
        let controller = makeController()
        let text1 = ":thumbs"
        controller.textChanged(text1)
        controller.cursorMoved(to: text1.utf16.count)
        controller.performMenuRefresh()

        controller.handleEmojiNavigation(.down)
        XCTAssertEqual(controller.emojiSelectedIndex, 1)

        // Change filter
        let text2 = ":heart"
        controller.textChanged(text2)
        controller.cursorMoved(to: text2.utf16.count)
        controller.performMenuRefresh()
        XCTAssertEqual(controller.emojiSelectedIndex, 0)
    }

    // MARK: - Emoji menu does not open when slash menu is active

    @MainActor
    func testEmojiMenuBlockedWhenSlashMenuOpen() {
        let controller = makeController()

        // Open slash menu
        controller.textChanged("/co")
        controller.performMenuRefresh()
        XCTAssertTrue(controller.showSlashMenu)

        // The emoji trigger range check should return nil when slash menu is open
        XCTAssertNil(controller.emojiTriggerRange(),
                     "Emoji trigger should be nil while slash menu is visible")
    }

    // MARK: - Focus intent

    @MainActor
    func testFocusChangedUpdatesIntent() {
        let controller = makeController()

        controller.focusChanged(true)
        XCTAssertTrue(controller.focusIntent)

        controller.focusChanged(false)
        XCTAssertFalse(controller.focusIntent)
    }

    @MainActor
    func testInteractionDisabledClearsFocus() {
        let controller = makeController()
        controller.focusChanged(true)
        XCTAssertTrue(controller.focusIntent)

        controller.interactionEnabledChanged(false)
        XCTAssertFalse(controller.focusIntent)
    }

    @MainActor
    func testInteractionReenabledRestoresFocus() {
        let controller = makeController()
        controller.interactionEnabledChanged(false)
        XCTAssertFalse(controller.focusIntent)

        controller.interactionEnabledChanged(true)
        XCTAssertTrue(controller.focusIntent)
    }

    @MainActor
    func testInteractionReenabledWithPendingConfirmationDoesNotFocus() {
        let controller = makeController()
        controller.interactionEnabledChanged(false)

        controller.interactionEnabledChanged(true, hasPendingConfirmation: true)
        XCTAssertFalse(controller.focusIntent,
                       "Should not auto-focus when pending confirmation exists")
    }

    // MARK: - Interaction disabled clears popups

    @MainActor
    func testInteractionDisabledClosesSlashMenu() {
        let controller = makeController()
        controller.textChanged("/co")
        controller.performMenuRefresh()
        XCTAssertTrue(controller.showSlashMenu)

        controller.interactionEnabledChanged(false)
        XCTAssertFalse(controller.showSlashMenu)
        XCTAssertFalse(controller.suppressSlashReopen)
    }

    @MainActor
    func testInteractionDisabledClosesEmojiMenu() {
        let controller = makeController()
        let text = ":thumbs"
        controller.textChanged(text)
        controller.cursorMoved(to: text.utf16.count)
        controller.performMenuRefresh()
        XCTAssertTrue(controller.showEmojiMenu)

        controller.interactionEnabledChanged(false)
        XCTAssertFalse(controller.showEmojiMenu)
        XCTAssertFalse(controller.suppressEmojiReopen)
    }

    // MARK: - Dictation

    @MainActor
    func testDictationStartedCapturesPreDictationText() {
        let controller = makeController()
        controller.textChanged("hello world")
        controller.dictationStarted()

        XCTAssertEqual(controller.preDictationText, "hello world")
    }

    @MainActor
    func testDictationStoppedClearsPreDictationText() {
        let controller = makeController()
        controller.textChanged("hello world")
        controller.dictationStarted()
        XCTAssertEqual(controller.preDictationText, "hello world")

        controller.dictationStopped()
        XCTAssertEqual(controller.preDictationText, "")
    }

    // MARK: - Query helpers

    @MainActor
    func testIsPopupVisibleReflectsMenuState() {
        let controller = makeController()
        XCTAssertFalse(controller.isPopupVisible)

        controller.textChanged("/")
        controller.performMenuRefresh()
        XCTAssertTrue(controller.isPopupVisible)
    }

    @MainActor
    func testSelectedSlashCommandReturnsCurrentSelection() {
        let controller = makeController()
        controller.textChanged("/")
        controller.performMenuRefresh()

        let selected = controller.selectedSlashCommand
        XCTAssertNotNil(selected)
        XCTAssertEqual(selected?.name, "commands")

        // Navigate down
        controller.handleSlashNavigation(.down)
        XCTAssertEqual(controller.selectedSlashCommand?.name, "compact")
    }

    @MainActor
    func testSelectedEmojiEntryReturnsCurrentSelection() {
        let controller = makeController()
        let text = ":thumbs"
        controller.textChanged(text)
        controller.cursorMoved(to: text.utf16.count)
        controller.performMenuRefresh()

        let selected = controller.selectedEmojiEntry
        XCTAssertNotNil(selected)
        XCTAssertEqual(selected?.shortcode, "thumbsup")
    }

    // MARK: - Emoji popup freeze regression

    /// Regression test matching the emoji popup flow from freeze reports:
    /// rapid typing of `:th` then immediate cursor movement should not
    /// leave the controller in an inconsistent state where the emoji menu
    /// is visible but the filter/selection are stale.
    @MainActor
    func testEmojiPopupRapidTypingDoesNotLeaveStaleState() {
        let controller = makeController()

        // Simulate rapid typing: `:`, `:t`, `:th` with cursor tracking
        controller.textChanged(":")
        controller.cursorMoved(to: 1)
        // No refresh fires yet (deferred), type more immediately

        controller.textChanged(":t")
        controller.cursorMoved(to: 2)
        // Still no refresh (superseded)

        controller.textChanged(":th")
        controller.cursorMoved(to: 3)
        // Only this final refresh should execute
        controller.performMenuRefresh()

        XCTAssertTrue(controller.showEmojiMenu, "Emoji menu should be open for ':th'")
        XCTAssertEqual(controller.emojiFilter, "th")
        XCTAssertEqual(controller.emojiSelectedIndex, 0)

        // Now simulate cursor jump (e.g. from arrow key) to beginning
        controller.cursorMoved(to: 0)
        controller.performMenuRefresh()

        // With cursor at position 0, the emoji trigger walk-back cannot find
        // a valid `:XX` range, so the menu should close cleanly
        XCTAssertFalse(controller.showEmojiMenu,
                       "Emoji menu should close when cursor moves before the colon trigger")
        XCTAssertEqual(controller.emojiSelectedIndex, 0,
                       "Selection should not be stale after menu close")
    }

    /// Another freeze regression scenario: opening emoji menu, navigating
    /// to a selection, then the input becoming empty (e.g. select-all + delete)
    /// should cleanly close the menu without leaving stale state.
    @MainActor
    func testEmojiMenuCleansUpOnInputClear() {
        let controller = makeController()

        // Open emoji menu and navigate
        let text = ":heart"
        controller.textChanged(text)
        controller.cursorMoved(to: text.utf16.count)
        controller.performMenuRefresh()
        XCTAssertTrue(controller.showEmojiMenu)

        controller.handleEmojiNavigation(.down)
        XCTAssertEqual(controller.emojiSelectedIndex, 1)

        // Simulate select-all + delete
        controller.textChanged("")
        controller.cursorMoved(to: 0)
        controller.performMenuRefresh()

        XCTAssertFalse(controller.showEmojiMenu)
    }

    // MARK: - Menu refresh supersession

    @MainActor
    func testCancelPendingMenuRefreshIncrementsGeneration() {
        let controller = makeController()

        // Schedule then cancel — performing a refresh after cancel should
        // still work (cancel only affects the deferred dispatch)
        controller.textChanged("/co")
        controller.cancelPendingMenuRefresh()

        // Direct performMenuRefresh still works
        controller.performMenuRefresh()
        XCTAssertTrue(controller.showSlashMenu)
    }
}
#endif
