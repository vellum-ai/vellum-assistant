import Foundation

/// The actions `computer_use_sequence` can batch, and how each maps onto the
/// single-action tool the helper already knows how to run. Only actions whose
/// outcome the model can know in advance are batchable; drag and AppleScript
/// stay single tools.
public enum ActionSequence {
    public static let maxActions = 10

    private static let toolNames: [String: String] = [
        "key": "computer_use_key",
        "type_text": "computer_use_type_text",
        // The name the helper itself uses for typing, which models reach for.
        "type": "computer_use_type_text",
        "click": "computer_use_click",
        "double_click": "computer_use_double_click",
        "right_click": "computer_use_right_click",
        "scroll": "computer_use_scroll",
        "wait": "computer_use_wait",
        "open_app": "computer_use_open_app",
    ]

    public static var supportedActions: [String] { toolNames.keys.sorted() }

    /// The single-action tool name for a batch item's `action`, or nil when
    /// the action cannot be batched.
    public static func toolName(forAction action: String) -> String? {
        toolNames[action]
    }

    /// Why a batch cannot run as given, or nil when every item names a
    /// batchable action and the count is in range. Checked before anything
    /// runs, so a malformed batch never half-executes.
    public static func problem(withActions actions: [String?]) -> String? {
        guard !actions.isEmpty else { return "computer_use_sequence needs at least one action." }
        guard actions.count <= maxActions else {
            return "computer_use_sequence takes at most \(maxActions) actions; got \(actions.count)."
        }
        for (index, action) in actions.enumerated() {
            guard let action, toolName(forAction: action) != nil else {
                return "Action \(index + 1) has unsupported action \"\(action ?? "")\". Supported: \(supportedActions.joined(separator: ", "))."
            }
        }
        return nil
    }
}
