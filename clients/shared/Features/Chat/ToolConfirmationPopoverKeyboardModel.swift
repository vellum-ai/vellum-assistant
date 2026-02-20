import Foundation

/// State machine for keyboard navigation within the Always Allow nested
/// popover menus (pattern list and scope list).
///
/// Platform-agnostic so it can be unit-tested without a host app.
struct ToolConfirmationPopoverKeyboardModel {

    /// Which step of the Always Allow flow is currently showing.
    enum Mode: Equatable {
        case patterns
        case scopes
    }

    /// Result of handling an Escape key press.
    enum EscapeResult: Equatable {
        /// Navigated back from scopes to patterns.
        case backToPatterns
        /// Popover should be closed entirely.
        case closePopover
    }

    private(set) var mode: Mode
    private(set) var selectedIndex: Int
    private let itemCount: Int

    /// Creates a model for a given mode and item count.
    /// Selection defaults to the first item.
    init(mode: Mode, itemCount: Int) {
        precondition(itemCount > 0, "Must have at least one item")
        self.mode = mode
        self.selectedIndex = 0
        self.itemCount = itemCount
    }

    /// Move selection up (wrapping around).
    mutating func moveUp() {
        selectedIndex = (selectedIndex - 1 + itemCount) % itemCount
    }

    /// Move selection down (wrapping around).
    mutating func moveDown() {
        selectedIndex = (selectedIndex + 1) % itemCount
    }

    /// Handle Escape: in scopes mode, go back to patterns; in patterns mode, close.
    func handleEscape() -> EscapeResult {
        switch mode {
        case .scopes:
            return .backToPatterns
        case .patterns:
            return .closePopover
        }
    }
}
