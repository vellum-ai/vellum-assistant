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
    /// Tag used on the "New Assistant…" item so tests / code inspection can
    /// find it without string matching.
    static let newAssistantTag = 9101
    /// Tag used on the parent "Retire" submenu item.
    static let retireParentTag = 9102
    /// Tag used on individual assistant row items. `representedObject` holds
    /// the assistant id string.
    static let assistantRowTag = 9103

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
            let empty = NSMenuItem(title: "No managed assistants", action: nil, keyEquivalent: "")
            empty.isEnabled = false
            items.append(empty)
        } else {
            for assistant in assistants {
                let item = NSMenuItem(
                    title: assistant.assistantId,
                    action: selectAction,
                    keyEquivalent: ""
                )
                item.target = target
                item.tag = assistantRowTag
                item.representedObject = assistant.assistantId
                item.state = (assistant.assistantId == activeId) ? .on : .off
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
        newItem.tag = newAssistantTag
        items.append(newItem)

        // Retire submenu: one entry per assistant (including the active one).
        // A `performRetire`-style path that only retires the *active* assistant
        // already exists, but retiring a non-active managed assistant from the
        // switcher is not yet implemented — gate those rows behind a TODO so
        // the UI shows the affordance without wiring an incomplete operation.
        // See `AssistantSwitcherViewModel.retire(assistantId:)`.
        let retireParent = NSMenuItem(title: "Retire", action: nil, keyEquivalent: "")
        retireParent.tag = retireParentTag
        let retireSubmenu = NSMenu(title: "Retire")
        retireSubmenu.autoenablesItems = false
        if assistants.isEmpty {
            let empty = NSMenuItem(title: "Nothing to retire", action: nil, keyEquivalent: "")
            empty.isEnabled = false
            retireSubmenu.addItem(empty)
        } else {
            for assistant in assistants {
                let item = NSMenuItem(
                    title: "Retire \(assistant.assistantId)…",
                    action: retireAction,
                    keyEquivalent: ""
                )
                item.target = target
                item.representedObject = assistant.assistantId
                retireSubmenu.addItem(item)
            }
        }
        retireParent.submenu = retireSubmenu
        retireParent.isEnabled = !assistants.isEmpty
        items.append(retireParent)

        return items
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
