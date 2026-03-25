import AppKit
import os

private let log = Logger(subsystem: "com.vellum.vellum-assistant", category: "DictationTextInserter")

@MainActor
final class DictationTextInserter {
    /// Insert text at the current cursor position in the frontmost app.
    /// Uses clipboard-paste (Cmd+V) with save/restore of previous clipboard contents.
    static func insertText(_ text: String) {
        let pasteboard = NSPasteboard.general

        // Save ALL pasteboard items with all their types so we can restore non-string
        // content (images, files, rich text) after pasting.
        let savedItems = savePasteboardItems(pasteboard)

        pasteboard.clearContents()
        pasteboard.setString(text, forType: .string)

        // Simulate Cmd+V
        let source = CGEventSource(stateID: .hidSystemState)
        guard let keyDown = CGEvent(keyboardEventSource: source, virtualKey: 9, keyDown: true),  // 9 = V key
              let keyUp = CGEvent(keyboardEventSource: source, virtualKey: 9, keyDown: false) else {
            log.error("Failed to create keyboard events for paste")
            restorePasteboardItems(savedItems, to: pasteboard)
            return
        }
        keyDown.flags = .maskCommand
        keyUp.flags = .maskCommand
        keyDown.post(tap: .cghidEventTap)
        usleep(50_000)
        keyUp.post(tap: .cghidEventTap)

        // Restore clipboard after delay
        let itemsToRestore = savedItems
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 500_000_000)
            restorePasteboardItems(itemsToRestore, to: NSPasteboard.general)
        }

        log.info("Inserted dictation text (\(text.count) chars)")
    }

    // MARK: - Clipboard Save/Restore

    /// Snapshot of a single pasteboard item: each type mapped to its raw data.
    private struct SavedPasteboardItem {
        let typeToData: [(NSPasteboard.PasteboardType, Data)]
    }

    /// Save all items and all their types from the pasteboard.
    private static func savePasteboardItems(_ pasteboard: NSPasteboard) -> [SavedPasteboardItem] {
        guard let items = pasteboard.pasteboardItems else { return [] }
        return items.map { item in
            let pairs: [(NSPasteboard.PasteboardType, Data)] = item.types.compactMap { type in
                guard let data = item.data(forType: type) else { return nil }
                return (type, data)
            }
            return SavedPasteboardItem(typeToData: pairs)
        }
    }

    /// Restore previously saved items to the pasteboard.
    private static func restorePasteboardItems(_ savedItems: [SavedPasteboardItem], to pasteboard: NSPasteboard) {
        pasteboard.clearContents()
        guard !savedItems.isEmpty else { return }
        let newItems: [NSPasteboardItem] = savedItems.map { saved in
            let item = NSPasteboardItem()
            for (type, data) in saved.typeToData {
                item.setData(data, forType: type)
            }
            return item
        }
        pasteboard.writeObjects(newItems)
    }
}
