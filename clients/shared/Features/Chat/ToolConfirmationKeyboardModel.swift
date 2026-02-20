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

    /// Move selection one step to the right, clamped at the end.
    mutating func moveRight() {
        selectedIndex = min(selectedIndex + 1, actions.count - 1)
    }

    /// Move selection one step to the left, clamped at the start.
    mutating func moveLeft() {
        selectedIndex = max(selectedIndex - 1, 0)
    }
}
