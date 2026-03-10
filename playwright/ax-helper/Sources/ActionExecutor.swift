import CoreGraphics
import AppKit
import ApplicationServices
import Foundation

enum ActionError: LocalizedError {
    case eventCreationFailed
    case accessibilityNotGranted

    var errorDescription: String? {
        switch self {
        case .eventCreationFailed: return "Failed to create CGEvent"
        case .accessibilityNotGranted: return "Accessibility permission not granted"
        }
    }
}

final class ActionExecutor {
    private let eventSource: CGEventSource?

    init() {
        eventSource = CGEventSource(stateID: .hidSystemState)
    }

    // MARK: - Mouse

    func click(at point: CGPoint) throws {
        try mouseMove(to: point)
        usleep(30_000)

        guard let mouseDown = CGEvent(mouseEventSource: eventSource, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left) else {
            throw ActionError.eventCreationFailed
        }
        mouseDown.post(tap: .cghidEventTap)
        usleep(50_000)

        guard let mouseUp = CGEvent(mouseEventSource: eventSource, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left) else {
            throw ActionError.eventCreationFailed
        }
        mouseUp.post(tap: .cghidEventTap)
    }

    private func mouseMove(to point: CGPoint) throws {
        guard let moveEvent = CGEvent(mouseEventSource: eventSource, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left) else {
            throw ActionError.eventCreationFailed
        }
        moveEvent.post(tap: .cghidEventTap)
    }

    // MARK: - Keyboard

    func typeText(_ text: String) throws {
        let pasteboard = NSPasteboard.general
        let previousContents = pasteboard.string(forType: .string)

        pasteboard.clearContents()
        pasteboard.setString(text, forType: .string)

        let verifiedContents = pasteboard.string(forType: .string)
        guard verifiedContents == text else {
            return
        }

        try keyCombo(keyCode: 9, modifiers: .maskCommand) // Cmd+V
        usleep(100_000)

        let saved = previousContents
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
            let pb = NSPasteboard.general
            pb.clearContents()
            if let saved = saved {
                pb.setString(saved, forType: .string)
            }
        }
    }

    func keyCombo(keyCode: CGKeyCode, modifiers: CGEventFlags) throws {
        guard let keyDown = CGEvent(keyboardEventSource: eventSource, virtualKey: keyCode, keyDown: true) else {
            throw ActionError.eventCreationFailed
        }
        keyDown.flags = modifiers
        keyDown.post(tap: .cghidEventTap)
        usleep(50_000)

        guard let keyUp = CGEvent(keyboardEventSource: eventSource, virtualKey: keyCode, keyDown: false) else {
            throw ActionError.eventCreationFailed
        }
        keyUp.flags = modifiers
        keyUp.post(tap: .cghidEventTap)
    }
}
