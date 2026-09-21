import AppKit
import ApplicationServices
import Carbon

/// A Command shortcut sent to the application in front: the paste that puts
/// dictated words at the cursor, and the undo that takes one back.
///
/// Needs only the helper's own Accessibility grant. Without it the events are
/// dropped silently, so the grant is checked first and its absence reported.
///
/// Posted to the front application's process rather than the HID stream, the
/// same way `FrontSelection` sends its copy, so the raw key monitor that
/// watches the voice key never sees a synthetic Command as a hold or a chord.
enum FrontShortcut {
    static let keys: [String: CGKeyCode] = [
        "v": CGKeyCode(kVK_ANSI_V),
        "z": CGKeyCode(kVK_ANSI_Z),
    ]

    enum Outcome: String {
        case posted
        /// Without Accessibility the events are dropped without a word, so
        /// this is reported rather than claimed as posted.
        case untrusted
        case noFrontApp
        case failed
    }

    static func post(key: CGKeyCode) -> Outcome {
        guard AXIsProcessTrusted() else {
            return .untrusted
        }
        guard let pid = NSWorkspace.shared.frontmostApplication?.processIdentifier else {
            return .noFrontApp
        }
        guard let down = CGEvent(keyboardEventSource: nil, virtualKey: key, keyDown: true),
              let up = CGEvent(keyboardEventSource: nil, virtualKey: key, keyDown: false)
        else {
            return .failed
        }
        down.flags = .maskCommand
        up.flags = .maskCommand
        down.postToPid(pid)
        up.postToPid(pid)
        return .posted
    }
}
