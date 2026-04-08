#if os(macOS)
import Foundation
import VellumAssistantShared

// MARK: - ComposerController

/// Isolated, testable state machine for hot composer UI state that is
/// currently spread across ComposerView body logic and SwiftUI bindings.
///
/// Accepts explicit events (`textChanged`, `cursorMoved`, `focusChanged`,
/// `interactionEnabledChanged`, `dictationStarted`, `dictationStopped`)
/// instead of reading SwiftUI bindings directly. All popup/focus decisions
/// live here so they can be unit-tested without importing SwiftUI view types.
@MainActor
final class ComposerController {

    // MARK: - Published state

    /// Whether the slash-command popup is visible.
    private(set) var showSlashMenu = false
    /// Current filter text for slash commands (characters after the leading `/`).
    private(set) var slashFilter = ""
    /// Highlighted row index in the slash popup.
    private(set) var slashSelectedIndex = 0

    /// Whether the emoji picker popup is visible.
    private(set) var showEmojiMenu = false
    /// Current filter text for emoji (characters between `:` and cursor).
    private(set) var emojiFilter = ""
    /// Highlighted row index in the emoji popup.
    private(set) var emojiSelectedIndex = 0

    /// Whether the composer should logically have focus.
    private(set) var focusIntent = false

    // MARK: - Suppress-reopen flags

    /// When true, the next text-change cycle skips reopening the slash menu.
    /// Survives exactly one `textChanged` call (user-driven close).
    private(set) var suppressSlashReopen = false
    /// When true, the next text-change cycle skips reopening the emoji menu.
    /// Survives exactly one `textChanged` call (user-driven close).
    private(set) var suppressEmojiReopen = false

    // MARK: - Internal bookkeeping

    /// Snapshot of input text captured when dictation starts, used to restore on cancel.
    private(set) var preDictationText: String = ""

    /// Current cursor position (UTF-16 offset).
    private var cursorPosition: Int = 0
    /// Current input text (kept in sync via events).
    private var inputText: String = ""
    /// Whether the composer interaction is enabled.
    private var isInteractionEnabled: Bool = true

    // MARK: - Menu refresh scheduling

    /// Generation counter for deferred menu-refresh scheduling.
    /// Incremented on every schedule; the deferred block only executes if
    /// its captured generation still matches, superseding stale refreshes.
    private var menuRefreshGeneration: Int = 0

    // MARK: - Dependencies

    /// Pluggable slash-command catalog for testability.
    let slashCommandProvider: SlashCommandProvider
    /// Pluggable emoji search for testability.
    let emojiSearchProvider: EmojiSearchProvider

    // MARK: - Initialization

    init(
        slashCommandProvider: SlashCommandProvider = DefaultSlashCommandProvider(),
        emojiSearchProvider: EmojiSearchProvider = DefaultEmojiSearchProvider()
    ) {
        self.slashCommandProvider = slashCommandProvider
        self.emojiSearchProvider = emojiSearchProvider
    }

    // MARK: - Events

    /// Called when the input text changes.
    func textChanged(_ newText: String) {
        inputText = newText
        scheduleMenuRefresh()
    }

    /// Called when the cursor position changes.
    func cursorMoved(to position: Int) {
        cursorPosition = position
        if !inputText.isEmpty {
            scheduleMenuRefresh()
        }
    }

    /// Called when the composer gains or loses focus.
    func focusChanged(_ focused: Bool) {
        focusIntent = focused
    }

    /// Called when the interaction-enabled state changes (e.g. assistant busy/idle).
    func interactionEnabledChanged(_ enabled: Bool, hasPendingConfirmation: Bool = false) {
        isInteractionEnabled = enabled
        if enabled, !hasPendingConfirmation {
            focusIntent = true
        } else if !enabled {
            cancelPendingMenuRefresh()
            focusIntent = false
            showSlashMenu = false
            showEmojiMenu = false
            suppressSlashReopen = false
            suppressEmojiReopen = false
        }
    }

    /// Called when dictation starts.
    func dictationStarted() {
        preDictationText = inputText
    }

    /// Called when dictation stops (accepted or cancelled).
    func dictationStopped() {
        preDictationText = ""
    }

    // MARK: - Menu refresh scheduling

    /// Schedules a deferred menu refresh. Supersedes any previously
    /// scheduled refresh that hasn't fired yet.
    func scheduleMenuRefresh() {
        menuRefreshGeneration += 1
        let capturedGeneration = menuRefreshGeneration
        DispatchQueue.main.async { [weak self] in
            guard let self, self.menuRefreshGeneration == capturedGeneration else { return }
            self.performMenuRefresh()
        }
    }

    /// Cancels any pending menu refresh without performing it.
    func cancelPendingMenuRefresh() {
        menuRefreshGeneration += 1
    }

    /// Synchronous menu refresh — evaluates slash and emoji state based
    /// on the current input text and cursor position. Exposed for testing.
    func performMenuRefresh() {
        if inputText.isEmpty {
            showSlashMenu = false
            showEmojiMenu = false
        } else {
            updateSlashState()
            updateEmojiState()
        }
    }

    // MARK: - Slash menu logic

    /// Evaluates whether the slash menu should be shown based on input text.
    private func updateSlashState() {
        if suppressSlashReopen {
            suppressSlashReopen = false
            return
        }
        let text = inputText

        if text.hasPrefix("/") && !text.contains(" ") {
            let filter = String(text.dropFirst())
            let filtered = slashCommandProvider.filteredCommands(filter)
            if !filtered.isEmpty {
                showSlashMenu = true
                if slashFilter != filter {
                    slashSelectedIndex = 0
                }
                slashFilter = filter
            } else {
                showSlashMenu = false
            }
        } else {
            showSlashMenu = false
        }
    }

    // MARK: - Emoji menu logic

    /// Evaluates whether the emoji menu should be shown based on input text and cursor.
    private func updateEmojiState() {
        if suppressEmojiReopen {
            suppressEmojiReopen = false
            return
        }
        if let trigger = emojiTriggerRange() {
            let results = emojiSearchProvider.search(query: trigger.filter)
            if !results.isEmpty {
                showEmojiMenu = true
                if emojiFilter != trigger.filter {
                    emojiSelectedIndex = 0
                }
                emojiFilter = trigger.filter
            } else {
                showEmojiMenu = false
            }
        } else {
            showEmojiMenu = false
        }
    }

    /// Walks backward from `cursorPosition` through `inputText` to find an
    /// unmatched `:` followed by 2+ alphanumeric/underscore characters.
    /// Returns nil if no valid trigger is found.
    func emojiTriggerRange() -> (colonIndex: String.Index, filter: String)? {
        guard !showSlashMenu else { return nil }
        guard cursorPosition > 0, cursorPosition <= inputText.utf16.count else { return nil }

        let cursorIdx = String.Index(utf16Offset: cursorPosition, in: inputText)
        var idx = cursorIdx

        while idx > inputText.startIndex {
            idx = inputText.index(before: idx)
            let ch = inputText[idx]

            if ch == ":" {
                let afterColon = inputText.index(after: idx)
                let filter = String(inputText[afterColon..<cursorIdx])
                guard filter.count >= 2 else { return nil }
                return (colonIndex: idx, filter: filter)
            }

            if ch.isWhitespace || (!ch.isLetter && !ch.isNumber && ch != "_") {
                return nil
            }
        }

        return nil
    }

    // MARK: - Slash navigation

    /// Handles keyboard navigation within the slash menu.
    /// Returns the selected command for `.select` actions, nil otherwise.
    @discardableResult
    func handleSlashNavigation(_ action: PopupNavigation) -> SlashCommand? {
        guard showSlashMenu else { return nil }
        let filtered = slashCommandProvider.filteredCommands(slashFilter)
        guard !filtered.isEmpty else { return nil }

        switch action {
        case .up:
            slashSelectedIndex = (slashSelectedIndex - 1 + filtered.count) % filtered.count
            return nil
        case .down:
            slashSelectedIndex = (slashSelectedIndex + 1) % filtered.count
            return nil
        case .select:
            let command = filtered[slashSelectedIndex]
            showSlashMenu = false
            slashSelectedIndex = 0
            return command
        case .tab:
            let command = filtered[slashSelectedIndex]
            let newText = command.selectedInputText
            if inputText != newText {
                suppressSlashReopen = true
            }
            showSlashMenu = false
            return command
        case .dismiss:
            showSlashMenu = false
            return nil
        }
    }

    // MARK: - Emoji navigation

    /// Handles keyboard navigation within the emoji menu.
    /// Returns the selected entry for `.select`/`.tab` actions, nil otherwise.
    @discardableResult
    func handleEmojiNavigation(_ action: PopupNavigation) -> EmojiEntry? {
        guard showEmojiMenu else { return nil }
        let filtered = emojiSearchProvider.search(query: emojiFilter, limit: 8)
        guard !filtered.isEmpty else { return nil }

        switch action {
        case .up:
            emojiSelectedIndex = (emojiSelectedIndex - 1 + filtered.count) % filtered.count
            return nil
        case .down:
            emojiSelectedIndex = (emojiSelectedIndex + 1) % filtered.count
            return nil
        case .select:
            let entry = filtered[emojiSelectedIndex]
            showEmojiMenu = false
            emojiSelectedIndex = 0
            return entry
        case .tab:
            let entry = filtered[emojiSelectedIndex]
            showEmojiMenu = false
            emojiSelectedIndex = 0
            return entry
        case .dismiss:
            showEmojiMenu = false
            suppressEmojiReopen = true
            return nil
        }
    }

    // MARK: - Query helpers

    /// Whether any popup is currently visible.
    var isPopupVisible: Bool {
        showSlashMenu || showEmojiMenu
    }

    /// The currently selected slash command, if the slash menu is visible.
    var selectedSlashCommand: SlashCommand? {
        guard showSlashMenu else { return nil }
        let filtered = slashCommandProvider.filteredCommands(slashFilter)
        guard slashSelectedIndex < filtered.count else { return nil }
        return filtered[slashSelectedIndex]
    }

    /// The currently selected emoji entry, if the emoji menu is visible.
    var selectedEmojiEntry: EmojiEntry? {
        guard showEmojiMenu else { return nil }
        let filtered = emojiSearchProvider.search(query: emojiFilter, limit: 8)
        guard emojiSelectedIndex < filtered.count else { return nil }
        return filtered[emojiSelectedIndex]
    }
}

// MARK: - Popup Navigation

/// Unified navigation actions for popup menus (slash commands and emoji).
enum PopupNavigation {
    case up, down, select, tab, dismiss
}

// MARK: - SlashCommandProvider

/// Protocol for providing slash commands, enabling test injection.
protocol SlashCommandProvider: Sendable {
    func filteredCommands(_ filter: String) -> [SlashCommand]
}

/// Default provider that delegates to the real `SlashCommand.all` catalog.
struct DefaultSlashCommandProvider: SlashCommandProvider {
    func filteredCommands(_ filter: String) -> [SlashCommand] {
        SlashCommand.all.filter {
            filter.isEmpty || $0.name.lowercased().hasPrefix(filter.lowercased())
        }
    }
}

// MARK: - EmojiSearchProvider

/// Protocol for searching emoji, enabling test injection.
protocol EmojiSearchProvider: Sendable {
    func search(query: String) -> [EmojiEntry]
    func search(query: String, limit: Int) -> [EmojiEntry]
}

extension EmojiSearchProvider {
    func search(query: String) -> [EmojiEntry] {
        search(query: query, limit: 8)
    }
}

/// Default provider that delegates to the real `EmojiCatalog`.
struct DefaultEmojiSearchProvider: EmojiSearchProvider {
    func search(query: String, limit: Int) -> [EmojiEntry] {
        EmojiCatalog.search(query: query, limit: limit)
    }
}
#endif
