import AppKit
import VellumAssistantShared
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "AssistantSwitcherMenu")

/// Builds the assistant-switcher section of the status-item menu. This type
/// owns no state — it is a pure builder that takes a view model and a target
/// (for `NSMenuItem.target`), and returns a list of `NSMenuItem`s ready to be
/// inserted into the parent menu.
///
/// Gating the section behind `multi-platform-assistant` is the caller's
/// responsibility: when the flag is off the caller must not invoke
/// `buildItems` at all, so the menu is byte-for-byte identical to the
/// pre-feature build.
@MainActor
enum AssistantSwitcherMenu {
    static func buildItems(
        viewModel: AssistantSwitcherViewModel,
        target: AnyObject,
        selectAction: Selector,
        createAction: Selector,
        retireAction: Selector
    ) -> [NSMenuItem] {
        var items: [NSMenuItem] = []

        let header = NSMenuItem(title: "Assistants", action: nil, keyEquivalent: "")
        header.isEnabled = false
        items.append(header)

        let assistants = viewModel.assistants
        let activeId = viewModel.selectedAssistantId

        if assistants.isEmpty {
            // Intentional first-launch-under-flag state: the user enabled
            // the switcher but has no managed assistants yet (e.g. they're
            // running a local-only lockfile). The "New Assistant…" row
            // below is the path forward.
            let empty = NSMenuItem(title: "No managed assistants", action: nil, keyEquivalent: "")
            empty.isEnabled = false
            items.append(empty)
        } else {
            for assistant in assistants {
                let isActive = assistant.assistantId == activeId
                let title = displayTitle(for: assistant, isActive: isActive)
                let item = NSMenuItem(
                    title: title,
                    action: selectAction,
                    keyEquivalent: ""
                )
                item.target = target
                item.representedObject = assistant.assistantId
                item.state = isActive ? .on : .off
                items.append(item)
            }
        }

        items.append(NSMenuItem.separator())

        let newItem = NSMenuItem(
            title: "New Assistant…",
            action: createAction,
            keyEquivalent: ""
        )
        newItem.target = target
        items.append(newItem)

        // Retire row: only surfaced for the *active* assistant, since the
        // existing retire path (`AppDelegate.performRetireAsync`) only
        // handles that case. Retiring a non-active managed assistant
        // requires a dedicated code path and is tracked as a follow-up —
        // don't show a row we can't back. See
        // `AppDelegate.retireManagedAssistantFromSwitcher`.
        if let activeId,
           let activeAssistant = assistants.first(where: { $0.assistantId == activeId }) {
            let activeTitle = displayTitle(for: activeAssistant, isActive: true)
            let retireItem = NSMenuItem(
                title: "Retire \(activeTitle)…",
                action: retireAction,
                keyEquivalent: ""
            )
            retireItem.target = target
            retireItem.representedObject = activeAssistant.assistantId
            items.append(retireItem)
        }

        return items
    }

    /// Resolve a user-facing title for a menu row. The active assistant
    /// prefers `IdentityInfo.current?.name` (the same source the status
    /// tooltip uses) so users see "Luna" rather than a raw UUID. Non-active
    /// assistants fall back to their id — LockfileAssistant doesn't carry a
    /// display name yet, so there's nothing better we can show without a
    /// per-assistant IDENTITY.md read. Both paths go through
    /// `AssistantDisplayName.resolve` so the bootstrap sentinel is masked.
    private static func displayTitle(for assistant: LockfileAssistant, isActive: Bool) -> String {
        if isActive {
            return AssistantDisplayName.resolve(IdentityInfo.current?.name, assistant.assistantId)
        }
        return AssistantDisplayName.resolve(assistant.assistantId)
    }

    /// Display a modal prompt for a new assistant name. Returns `nil` when
    /// the user cancels or submits an empty string.
    static func promptForNewAssistantName() -> String? {
        let alert = NSAlert()
        alert.messageText = "New Assistant"
        alert.informativeText = "Give this assistant a name. You can change it later."
        alert.alertStyle = .informational
        alert.addButton(withTitle: "Create")
        alert.addButton(withTitle: "Cancel")

        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 260, height: 24))
        field.placeholderString = "Assistant name"
        alert.accessoryView = field
        alert.window.initialFirstResponder = field

        let response = alert.runModal()
        guard response == .alertFirstButtonReturn else { return nil }
        let trimmed = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
