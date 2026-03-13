import Foundation

/// Describes a single keyboard shortcut that can be customized by the user.
struct KeyboardShortcutDefinition {
    /// UserDefaults key used to persist the user's custom shortcut.
    let id: String
    /// Human-readable label shown in the Settings UI (e.g. "New Conversation").
    let label: String
    /// Default shortcut string (e.g. "cmd+n").
    let defaultShortcut: String
    /// Raw virtual key code for Carbon `RegisterEventHotKey`, or nil when Carbon
    /// registration is not needed.
    let defaultKeyCode: Int?
    /// Whether this shortcut is monitored globally (true) or only while the app
    /// is active (false).
    let isGlobal: Bool
    /// Whether this shortcut requires Carbon `RegisterEventHotKey` registration.
    let requiresCarbonHotkey: Bool
}

/// Central registry of all keyboard shortcuts in the app.
///
/// Every shortcut the app listens for is declared here so that the Settings UI,
/// conflict detection, and input monitors can share a single source of truth.
enum KeyboardShortcutRegistry {

    static let allShortcuts: [KeyboardShortcutDefinition] = [
        KeyboardShortcutDefinition(
            id: "globalHotkeyShortcut",
            label: "Open Vellum",
            defaultShortcut: "cmd+shift+g",
            defaultKeyCode: nil,
            isGlobal: true,
            requiresCarbonHotkey: false
        ),
        KeyboardShortcutDefinition(
            id: "quickInputHotkeyShortcut",
            label: "Quick Input",
            defaultShortcut: "cmd+shift+/",
            defaultKeyCode: 44, // kVK_ANSI_Slash
            isGlobal: true,
            requiresCarbonHotkey: true
        ),
        KeyboardShortcutDefinition(
            id: "quickInputAboveDockShortcut",
            label: "Quick Input Above Dock",
            defaultShortcut: "cmd+shift+v",
            defaultKeyCode: nil,
            isGlobal: true,
            requiresCarbonHotkey: false
        ),
        KeyboardShortcutDefinition(
            id: "newThreadShortcut",
            label: "New Conversation",
            defaultShortcut: "cmd+n",
            defaultKeyCode: nil,
            isGlobal: false,
            requiresCarbonHotkey: false
        ),
        KeyboardShortcutDefinition(
            id: "commandPaletteShortcut",
            label: "Command Palette",
            defaultShortcut: "cmd+k",
            defaultKeyCode: nil,
            isGlobal: false,
            requiresCarbonHotkey: false
        ),
        KeyboardShortcutDefinition(
            id: "navigateBackShortcut",
            label: "Navigate Back",
            defaultShortcut: "cmd+[",
            defaultKeyCode: nil,
            isGlobal: false,
            requiresCarbonHotkey: false
        ),
        KeyboardShortcutDefinition(
            id: "navigateForwardShortcut",
            label: "Navigate Forward",
            defaultShortcut: "cmd+]",
            defaultKeyCode: nil,
            isGlobal: false,
            requiresCarbonHotkey: false
        ),
        KeyboardShortcutDefinition(
            id: "zoomInShortcut",
            label: "Zoom In",
            defaultShortcut: "cmd+=",
            defaultKeyCode: nil,
            isGlobal: false,
            requiresCarbonHotkey: false
        ),
        KeyboardShortcutDefinition(
            id: "zoomOutShortcut",
            label: "Zoom Out",
            defaultShortcut: "cmd+-",
            defaultKeyCode: nil,
            isGlobal: false,
            requiresCarbonHotkey: false
        ),
        KeyboardShortcutDefinition(
            id: "zoomResetShortcut",
            label: "Actual Size",
            defaultShortcut: "cmd+0",
            defaultKeyCode: nil,
            isGlobal: false,
            requiresCarbonHotkey: false
        ),
    ]

    /// Returns the first shortcut definition whose current (or default) value
    /// conflicts with `shortcut`, ignoring the definition identified by
    /// `excluding`.
    static func conflictingShortcut(
        for shortcut: String,
        excluding id: String
    ) -> KeyboardShortcutDefinition? {
        let normalizedTarget = ShortcutHelper.normalizeShortcut(shortcut)
        guard !normalizedTarget.isEmpty else { return nil }

        return allShortcuts.first { definition in
            guard definition.id != id else { return false }
            let current = currentShortcut(for: definition.id)
            let normalizedCurrent = ShortcutHelper.normalizeShortcut(current)
            return normalizedCurrent == normalizedTarget
        }
    }

    /// Returns the user's current shortcut for the given definition id,
    /// falling back to the definition's default if no override is stored.
    static func currentShortcut(for id: String) -> String {
        if let stored = UserDefaults.standard.string(forKey: id) {
            return stored
        }
        return allShortcuts.first { $0.id == id }?.defaultShortcut ?? ""
    }
}
