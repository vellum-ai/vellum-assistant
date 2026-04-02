#if os(macOS)
import AppKit
import SwiftUI
import Observation

// MARK: - WeakNSViewRef

/// Weak reference wrapper for NSView, used to store item view references
/// without creating retain cycles.
final class WeakNSViewRef {
    weak var view: NSView?
    init(view: NSView) { self.view = view }
}

// MARK: - VMenuCoordinator

/// Manages the lifecycle of a parent→child `VMenuPanel` stack.
///
/// Responsibilities:
/// - Owns the ordered panel stack (max 2: root + one child).
/// - Installs a single click-outside `NSEvent` monitor that covers all panels.
/// - Manages grace-period timer for delayed child dismiss.
/// - Observes the source window for close notification.
/// - Provides `dismissAll()` (injected as `vMenuDismiss`) and `dismissChild()`.
/// - Tracks keyboard focus state for arrow-key navigation, activation, and VoiceOver bridging.
///
/// Keyboard focus is tracked via `focusedIndex` (observed by SwiftUI views through
/// the Observation framework). When a user presses arrow keys, `focusedIndex` updates
/// and SwiftUI re-renders the appropriate items with a focus highlight. Mouse movement
/// clears keyboard focus, switching back to hover-driven interaction.
///
/// References:
/// - [NSAccessibility.post](https://developer.apple.com/documentation/appkit/nsaccessibility/post(element:notification:))
/// - [Observation framework](https://developer.apple.com/documentation/observation)
@Observable
@MainActor
public final class VMenuCoordinator {
    /// Ordered stack of open panels. Index 0 = root, index 1 = child.
    @ObservationIgnored private(set) var panels: [NSPanel] = []
    @ObservationIgnored private var clickMonitor: Any?
    @ObservationIgnored private var windowObserver: Any?
    @ObservationIgnored private var appDeactivationObserver: Any?
    @ObservationIgnored private var mouseMoveMonitor: Any?
    @ObservationIgnored private var lastKeyboardEventTime: TimeInterval = 0
    @ObservationIgnored private var graceTimer: DispatchWorkItem?
    @ObservationIgnored private var rootDismissHandler: (() -> Void)?
    /// Screen rect to exclude from click-outside dismiss (e.g., the trigger button).
    @ObservationIgnored private var excludeRect: CGRect?
    /// The window the menu was opened from, used to attach child panels.
    @ObservationIgnored private weak var sourceWindow: NSWindow?

    /// Max depth: root + one submenu.
    static let maxDepth = 2

    /// Whether a child panel is currently open.
    var hasChild: Bool { panels.count > 1 }

    // MARK: - Keyboard Focus (M3)

    /// Focused item index per panel level. Key absent = no keyboard focus (mouse-driven).
    ///
    /// This is the primary observed property — SwiftUI views react to changes here
    /// to show/hide the keyboard focus highlight. The Observation framework tracks
    /// reads of this property in view `body` computations and triggers re-renders
    /// when the value changes.
    var focusedIndex: [Int: Int] = [:]

    /// Total item count per panel level (derived from `itemOrder`).
    @ObservationIgnored var itemCounts: [Int: Int] = [:]

    /// Ordered list of item UUIDs per panel level, in layout order.
    /// Populated by VMenu via `onPreferenceChange(VMenuItemRegistrationKey.self)`.
    @ObservationIgnored var itemOrder: [Int: [UUID]] = [:]

    /// Action closures for each item, keyed by (level, UUID).
    /// Invoked when Enter/Space is pressed on the focused item.
    @ObservationIgnored var itemActions: [Int: [UUID: () -> Void]] = [:]

    /// Submenu-open closures for VSubMenuItems, keyed by (level, UUID).
    /// Invoked when → arrow is pressed on a focused submenu item.
    @ObservationIgnored var submenuActions: [Int: [UUID: () -> Void]] = [:]

    /// Weak references to NSViews embedded in each item, for VoiceOver focus notifications.
    @ObservationIgnored var itemNSViews: [Int: [UUID: WeakNSViewRef]] = [:]

    // MARK: - Item Registration

    /// Update the ordered list of item UUIDs for a panel level.
    /// Called by VMenu when the preference key collects item registrations.
    func updateItemOrder(level: Int, ids: [UUID]) {
        itemOrder[level] = ids
        itemCounts[level] = ids.count
    }

    /// Register an action closure for a menu item at the given level.
    /// Also ensures the item is tracked in `itemOrder`/`itemCounts` as a fallback
    /// in case `onPreferenceChange` hasn't fired yet.
    func registerItemAction(level: Int, id: UUID, action: @escaping () -> Void) {
        if itemActions[level] == nil { itemActions[level] = [:] }
        itemActions[level]?[id] = action

        // Belt-and-suspenders: ensure this item is counted even if the preference
        // key collection hasn't fired yet. The preference-based `updateItemOrder`
        // will override with the correct layout order when it fires.
        if itemOrder[level] == nil { itemOrder[level] = [] }
        if !itemOrder[level]!.contains(id) {
            itemOrder[level]!.append(id)
            itemCounts[level] = itemOrder[level]!.count
        }
    }

    /// Register a submenu-open closure for a VSubMenuItem at the given level.
    func registerSubmenuAction(level: Int, id: UUID, action: @escaping () -> Void) {
        if submenuActions[level] == nil { submenuActions[level] = [:] }
        submenuActions[level]?[id] = action
    }

    /// Register an NSView reference for a menu item (used for VoiceOver focus notifications).
    func registerItemNSView(level: Int, id: UUID, view: NSView) {
        if itemNSViews[level] == nil { itemNSViews[level] = [:] }
        itemNSViews[level]?[id] = WeakNSViewRef(view: view)
    }

    /// Return the UUID of the currently focused item at a level, if any.
    func focusedItemID(at level: Int) -> UUID? {
        guard let focusIdx = focusedIndex[level],
              let ids = itemOrder[level],
              focusIdx < ids.count else { return nil }
        return ids[focusIdx]
    }

    // MARK: - Panel Lifecycle

    /// Register the root panel and install the unified click monitor.
    func registerRootPanel(_ panel: NSPanel, sourceWindow: NSWindow?, excludeRect: CGRect? = nil, onDismiss: (() -> Void)?) {
        panels = [panel]
        rootDismissHandler = onDismiss
        self.excludeRect = excludeRect
        self.sourceWindow = sourceWindow
        focusedIndex = [:]
        itemCounts = [:]
        itemOrder = [:]
        itemActions = [:]
        submenuActions = [:]
        itemNSViews = [:]
        installClickMonitor()
        installMouseMoveMonitor()

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

        // Dismiss menus when the app loses focus, matching native NSMenu behavior.
        appDeactivationObserver = NotificationCenter.default.addObserver(
            forName: NSApplication.didResignActiveNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor [weak self] in
                self?.dismissAll()
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

        // Attach the child panel to the source window so it stays
        // grouped with the app and doesn't float above other apps.
        if let sourceWindow {
            sourceWindow.addChildWindow(childPanel, ordered: .above)
        }

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
        itemOrder.removeAll()
        itemActions.removeAll()
        submenuActions.removeAll()
        itemNSViews.removeAll()
        removeClickMonitor()
        removeWindowObserver()
        removeAppDeactivationObserver()
        removeMouseMoveMonitor()
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
        itemOrder.removeValue(forKey: childLevel)
        itemActions.removeValue(forKey: childLevel)
        submenuActions.removeValue(forKey: childLevel)
        itemNSViews.removeValue(forKey: childLevel)
        if let menuPanel = child as? VMenuPanel {
            menuPanel.closeFromCoordinator()
        } else {
            child.close()
        }

        // Restore VoiceOver focus to the parent level's currently focused item.
        let parentLevel = panels.count - 1
        if parentLevel >= 0 {
            postVoiceOverFocusNotification(level: parentLevel)
        }
    }

    /// Called when a panel is closed externally (e.g., AppKit window management).
    func panelWasClosed(_ panel: NSPanel) {
        guard let idx = panels.firstIndex(where: { $0 === panel }) else { return }
        let previousCount = panels.count
        // Close descendant panels too
        for i in stride(from: panels.count - 1, through: idx + 1, by: -1) {
            if let menuPanel = panels[i] as? VMenuPanel {
                menuPanel.closeFromCoordinator()
            } else {
                panels[i].close()
            }
        }
        panels.removeSubrange(idx...)

        // Clean up registration data for removed levels
        for level in idx..<previousCount {
            focusedIndex.removeValue(forKey: level)
            itemCounts.removeValue(forKey: level)
            itemOrder.removeValue(forKey: level)
            itemActions.removeValue(forKey: level)
            submenuActions.removeValue(forKey: level)
            itemNSViews.removeValue(forKey: level)
        }

        if panels.isEmpty {
            removeClickMonitor()
            removeWindowObserver()
            removeAppDeactivationObserver()
            removeMouseMoveMonitor()
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

        // Record the time of this keyboard event so the mouse-move monitor
        // can ignore micro-movements that would immediately clear the focus.
        lastKeyboardEventTime = ProcessInfo.processInfo.systemUptime

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
        case 124: // Right arrow — open submenu if focused item is a VSubMenuItem
            if let focusedID = focusedItemID(at: level),
               let action = submenuActions[level]?[focusedID] {
                action()
                // Move focus into the newly opened child
                if hasChild {
                    moveFocus(direction: 1, level: level + 1)
                }
                return true
            }
            return false
        case 36, 49: // Enter, Space — activate focused item
            if let focusedID = focusedItemID(at: level),
               let action = itemActions[level]?[focusedID] {
                action()
                return true
            }
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

        postVoiceOverFocusNotification(level: level)
    }

    /// Clear keyboard focus (switch back to mouse-driven interaction).
    func clearKeyboardFocus() {
        if !focusedIndex.isEmpty {
            focusedIndex.removeAll()
        }
    }

    // MARK: - VoiceOver Bridge

    /// Post an accessibility focus notification for the currently focused item,
    /// so VoiceOver tracks keyboard navigation.
    private func postVoiceOverFocusNotification(level: Int) {
        guard let focusedID = focusedItemID(at: level),
              let nsView = itemNSViews[level]?[focusedID]?.view else { return }

        // Walk up the view hierarchy to find the nearest accessibility element.
        // The VMenuItem's `.accessibilityElement(children: .combine)` creates a
        // single combined element that is the accessible parent of our helper NSView.
        if let accessibleElement = findAccessibleElement(from: nsView) {
            NSAccessibility.post(element: accessibleElement, notification: .focusedUIElementChanged)
        }
    }

    /// Walk up the NSView hierarchy to find the nearest view that is an accessibility element.
    private func findAccessibleElement(from view: NSView) -> Any? {
        var current: NSView? = view.superview
        while let v = current {
            if v.isAccessibilityElement() { return v }
            current = v.superview
        }
        return view
    }

    // MARK: - Mouse Move Monitor

    /// Install a mouse movement monitor that clears keyboard focus when the user moves the mouse.
    /// This matches native NSMenu behavior: arrow keys enter keyboard mode, mouse movement exits.
    ///
    /// A 200ms debounce after the last keyboard event prevents trackpad/mouse micro-jitter
    /// from clearing the focus highlight before SwiftUI has a chance to render it.
    private func installMouseMoveMonitor() {
        removeMouseMoveMonitor()
        mouseMoveMonitor = NSEvent.addLocalMonitorForEvents(matching: [.mouseMoved]) { [weak self] event in
            guard let self else { return event }
            // Ignore mouse movements within 200ms of a keyboard event to prevent
            // micro-movements from clearing focus before SwiftUI renders the highlight.
            let now = ProcessInfo.processInfo.systemUptime
            if now - self.lastKeyboardEventTime > 0.2 {
                self.clearKeyboardFocus()
            }
            return event
        }
    }

    private func removeMouseMoveMonitor() {
        if let monitor = mouseMoveMonitor {
            NSEvent.removeMonitor(monitor)
            mouseMoveMonitor = nil
        }
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

    private func removeAppDeactivationObserver() {
        if let observer = appDeactivationObserver {
            NotificationCenter.default.removeObserver(observer)
            appDeactivationObserver = nil
        }
    }

    deinit {
        if let monitor = clickMonitor {
            NSEvent.removeMonitor(monitor)
        }
        if let observer = windowObserver {
            NotificationCenter.default.removeObserver(observer)
        }
        if let observer = appDeactivationObserver {
            NotificationCenter.default.removeObserver(observer)
        }
        if let monitor = mouseMoveMonitor {
            NSEvent.removeMonitor(monitor)
        }
    }
}
#endif
