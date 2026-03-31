#if os(macOS)
import AppKit
import SwiftUI

// MARK: - VMenuCoordinator

/// Manages the lifecycle of a parent→child `VMenuPanel` stack.
///
/// Responsibilities:
/// - Owns the ordered panel stack (max 2: root + one child).
/// - Installs a single click-outside `NSEvent` monitor that covers all panels.
/// - Manages grace-period timer for delayed child dismiss.
/// - Observes the source window for close notification.
/// - Provides `dismissAll()` (injected as `vMenuDismiss`) and `dismissChild()`.
@MainActor
public final class VMenuCoordinator {
    /// Ordered stack of open panels. Index 0 = root, index 1 = child.
    private(set) var panels: [NSPanel] = []
    private var clickMonitor: Any?
    private var windowObserver: Any?
    private var graceTimer: DispatchWorkItem?
    private var rootDismissHandler: (() -> Void)?
    /// Screen rect to exclude from click-outside dismiss (e.g., the trigger button).
    private var excludeRect: CGRect?

    /// Max depth: root + one submenu.
    static let maxDepth = 2

    /// Whether a child panel is currently open.
    var hasChild: Bool { panels.count > 1 }

    // MARK: - Keyboard Focus (M3)

    /// Focused item index per panel level. Key absent = no keyboard focus (mouse-driven).
    var focusedIndex: [Int: Int] = [:]
    /// Total item count per panel level (set by VMenu via preference key).
    var itemCounts: [Int: Int] = [:]

    // MARK: - Panel Lifecycle

    /// Register the root panel and install the unified click monitor.
    func registerRootPanel(_ panel: NSPanel, sourceWindow: NSWindow?, excludeRect: CGRect? = nil, onDismiss: (() -> Void)?) {
        panels = [panel]
        rootDismissHandler = onDismiss
        self.excludeRect = excludeRect
        focusedIndex = [:]
        itemCounts = [:]
        installClickMonitor()

        if let sourceWindow {
            windowObserver = NotificationCenter.default.addObserver(
                forName: NSWindow.willCloseNotification,
                object: sourceWindow,
                queue: .main
            ) { [weak self] _ in
                Task { @MainActor [weak self] in
                    self?.dismissAll()
                }
            }
        }
    }

    /// Open a child panel anchored to the given screen rect.
    func showChild<Content: View>(
        anchoredTo itemRect: CGRect,
        width: CGFloat?,
        sourceAppearance: NSAppearance?,
        @ViewBuilder content: () -> Content
    ) {
        guard panels.count < Self.maxDepth else { return }

        // Close existing child first (one child at a time)
        if hasChild {
            dismissChild()
        }

        cancelGraceTimer()

        let childPanel = VMenuPanel.showAnchored(
            to: itemRect,
            sourceAppearance: sourceAppearance,
            coordinator: self,
            content: content
        )
        panels.append(childPanel)
        // Reset focus for the new child level
        focusedIndex.removeValue(forKey: panels.count - 1)
    }

    /// Close all panels, fire the root dismiss handler.
    func dismissAll() {
        cancelGraceTimer()
        let handler = rootDismissHandler
        rootDismissHandler = nil
        for panel in panels.reversed() {
            if let menuPanel = panel as? VMenuPanel {
                menuPanel.closeFromCoordinator()
            } else {
                panel.close()
            }
        }
        panels.removeAll()
        focusedIndex.removeAll()
        itemCounts.removeAll()
        removeClickMonitor()
        removeWindowObserver()
        handler?()
    }

    /// Close only the child panel (the deepest in the stack).
    func dismissChild() {
        cancelGraceTimer()
        guard panels.count > 1 else { return }
        let child = panels.removeLast()
        let childLevel = panels.count
        focusedIndex.removeValue(forKey: childLevel)
        itemCounts.removeValue(forKey: childLevel)
        if let menuPanel = child as? VMenuPanel {
            menuPanel.closeFromCoordinator()
        } else {
            child.close()
        }
    }

    /// Called when a panel is closed externally (e.g., AppKit window management).
    func panelWasClosed(_ panel: NSPanel) {
        guard let idx = panels.firstIndex(where: { $0 === panel }) else { return }
        // Close descendant panels too
        for i in stride(from: panels.count - 1, through: idx + 1, by: -1) {
            if let menuPanel = panels[i] as? VMenuPanel {
                menuPanel.closeFromCoordinator()
            } else {
                panels[i].close()
            }
        }
        panels.removeSubrange(idx...)

        if panels.isEmpty {
            removeClickMonitor()
            removeWindowObserver()
            let handler = rootDismissHandler
            rootDismissHandler = nil
            handler?()
        }
    }

    // MARK: - Grace Timer

    /// Start a 200ms timer that dismisses the child panel.
    ///
    /// When the timer fires, the cursor position is checked against the child
    /// panel's frame. If the cursor is inside the child, the dismiss is skipped —
    /// this handles the case where AppKit does not send `mouseEntered` when a
    /// tracking area is created with the cursor already inside it.
    func startGraceTimer() {
        cancelGraceTimer()
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.hasChild else { return }
            // If the cursor is inside the child panel, skip dismiss.
            // AppKit may not have fired mouseEntered for the child's tracking
            // area if it was created under the cursor.
            if let childPanel = self.panels.last {
                let mouseLocation = NSEvent.mouseLocation
                let locationInPanel = childPanel.convertPoint(fromScreen: mouseLocation)
                let panelBounds = childPanel.contentView?.bounds ?? .zero
                if panelBounds.contains(locationInPanel) {
                    return
                }
            }
            self.dismissChild()
        }
        graceTimer = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2, execute: work)
    }

    func cancelGraceTimer() {
        graceTimer?.cancel()
        graceTimer = nil
    }

    // MARK: - Keyboard Navigation (M3)

    /// Handle a key event from a panel. Returns `true` if handled.
    func handleKeyDown(_ event: NSEvent) -> Bool {
        let level = panels.count - 1
        guard level >= 0 else { return false }

        switch event.keyCode {
        case 126: // Up arrow
            moveFocus(direction: -1, level: level)
            return true
        case 125: // Down arrow
            moveFocus(direction: 1, level: level)
            return true
        case 123: // Left arrow
            if level > 0 {
                dismissChild()
                return true
            }
            return false
        case 124: // Right arrow — handled by VSubMenuItem activation
            return false
        case 36, 49: // Enter, Space — activation handled by focused VMenuItem
            return false
        default:
            return false
        }
    }

    private func moveFocus(direction: Int, level: Int) {
        let count = itemCounts[level] ?? 0
        guard count > 0 else { return }

        let current = focusedIndex[level] ?? (direction > 0 ? -1 : count)
        let next = (current + direction + count) % count
        focusedIndex[level] = next
    }

    /// Clear keyboard focus (switch back to mouse-driven interaction).
    func clearKeyboardFocus() {
        focusedIndex.removeAll()
    }

    // MARK: - Click Monitor

    private func installClickMonitor() {
        removeClickMonitor()
        DispatchQueue.main.async { [weak self] in
            self?.clickMonitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] event in
                guard let self else { return event }
                let mouseLocation = NSEvent.mouseLocation

                for panel in self.panels {
                    let locationInPanel = panel.convertPoint(fromScreen: mouseLocation)
                    let panelBounds = panel.contentView?.bounds ?? .zero
                    if panelBounds.contains(locationInPanel) {
                        return event
                    }
                }

                // Skip dismiss if click is in the trigger's excluded rect — let the
                // trigger button handle closing so it doesn't immediately reopen.
                if let excludeRect = self.excludeRect, excludeRect.contains(mouseLocation) {
                    return event
                }

                self.dismissAll()
                return event
            }
        }
    }

    private func removeClickMonitor() {
        if let monitor = clickMonitor {
            NSEvent.removeMonitor(monitor)
            clickMonitor = nil
        }
    }

    private func removeWindowObserver() {
        if let observer = windowObserver {
            NotificationCenter.default.removeObserver(observer)
            windowObserver = nil
        }
    }

    deinit {
        if let monitor = clickMonitor {
            NSEvent.removeMonitor(monitor)
        }
        if let observer = windowObserver {
            NotificationCenter.default.removeObserver(observer)
        }
    }
}
#endif
