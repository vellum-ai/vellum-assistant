import AppKit
import os

private let log = Logger(subsystem: "com.vellum.vellum-assistant", category: "DictationTextInserter")

@MainActor
final class DictationTextInserter {
    /// Insert text at the current cursor position in the frontmost app.
    /// Uses clipboard-paste (Cmd+V) with save/restore of previous clipboard contents.
    static func insertText(_ text: String) {
        let pasteboard = NSPasteboard.general
        let previousContents = pasteboard.string(forType: .string)

        pasteboard.clearContents()
        pasteboard.setString(text, forType: .string)

        // Simulate Cmd+V
        let source = CGEventSource(stateID: .hidSystemState)
        guard let keyDown = CGEvent(keyboardEventSource: source, virtualKey: 9, keyDown: true),  // 9 = V key
              let keyUp = CGEvent(keyboardEventSource: source, virtualKey: 9, keyDown: false) else {
            log.error("Failed to create keyboard events for paste")
            return
        }
        keyDown.flags = .maskCommand
        keyUp.flags = .maskCommand
        keyDown.post(tap: .cghidEventTap)
        usleep(50_000)
        keyUp.post(tap: .cghidEventTap)

        // Restore clipboard after delay
        let saved = previousContents
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
            let pb = NSPasteboard.general
            pb.clearContents()
            if let saved = saved {
                pb.setString(saved, forType: .string)
            }
        }

        log.info("Inserted dictation text (\(text.count) chars)")
    }
}
