import Foundation

/// Lightweight state machine for keyboard navigation across the top-level
/// tool-confirmation action buttons (Allow Once, Always Allow, Don't Allow).
///
/// macOS-only at runtime, but the model itself is platform-agnostic so it
/// can be unit-tested without a host app.
struct ToolConfirmationKeyboardModel {

    /// The logical actions that can appear in the button row.
    enum Action: Equatable {
        case allowOnce
        case allow10m
        case allowConversation
        case alwaysAllow
        case dontAllow
    }

    /// Ordered list of currently visible actions.
    private(set) var actions: [Action]

    /// Index of the currently selected action.
    private(set) var selectedIndex: Int

    /// Creates a model with the given ordered list of actions.
    /// Selection defaults to the first action (Allow Once).
    init(actions: [Action]) {
        precondition(!actions.isEmpty, "Must have at least one action")
        self.actions = actions
        self.selectedIndex = 0
    }

    /// The currently selected action.
    var selectedAction: Action {
        actions[selectedIndex]
    }

    /// Move selection one step to the right, wrapping around to the start.
    mutating func moveRight() {
        selectedIndex = (selectedIndex + 1) % actions.count
    }

    /// Move selection one step to the left, wrapping around to the end.
    mutating func moveLeft() {
        selectedIndex = (selectedIndex - 1 + actions.count) % actions.count
    }
}
