#if os(macOS)
import AppKit
import Combine
import SwiftUI

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
/// - [Combine framework](https://developer.apple.com/documentation/combine)
@MainActor
public final class VMenuCoordinator {
    /// Ordered stack of open panels. Index 0 = root, index 1 = child.
    private(set) var panels: [NSPanel] = []
    private var clickMonitor: Any?
    private var windowObserver: Any?
    private var appDeactivationObserver: Any?
    private var mouseMoveMonitor: Any?
    private var keyboardMonitor: Any?
    private var lastKeyboardEventTime: TimeInterval = 0
    private var graceTimer: DispatchWorkItem?
    private var rootDismissHandler: (() -> Void)?
    /// Screen rect to exclude from click-outside dismiss (e.g., the trigger button).
    private var excludeRect: CGRect?
    /// The window the menu was opened from, used to attach child panels.
    private weak var sourceWindow: NSWindow?

    /// Max depth: root + one submenu.
    static let maxDepth = 2

    /// Whether a child panel is currently open.
    var hasChild: Bool { panels.count > 1 }

    // MARK: - Keyboard Focus (M3)

    /// Subject for signaling VMenu to clear keyboard focus (e.g., on mouse move).
    /// VMenu subscribes via `.onReceive(clearFocusAnyPublisher)` and sets its `@State focusedItemID = nil`.
    let clearFocusSubject = PassthroughSubject<Void, Never>()

    /// Subject for signaling VMenu that the focused item changed via the fallback key-handling path
    /// (VMenuPanel.keyDown → coordinator.handleKeyDown). VMenu subscribes and updates `@State`.
    let focusChangeSubject = PassthroughSubject<UUID?, Never>()

    /// Type-erased publisher for VMenu to subscribe to clear-focus signals.
    var clearFocusAnyPublisher: AnyPublisher<Void, Never> {
        clearFocusSubject.eraseToAnyPublisher()
    }

    /// Type-erased publisher for VMenu to subscribe to focus-change signals (fallback path).
    var focusChangeAnyPublisher: AnyPublisher<UUID?, Never> {
        focusChangeSubject.eraseToAnyPublisher()
    }

    /// Focused item index per panel level. Key absent = no keyboard focus (mouse-driven).
    var focusedIndex: [Int: Int] = [:]

    /// Total item count per panel level (derived from `itemOrder`).
    var itemCounts: [Int: Int] = [:]

    /// Ordered list of item UUIDs per panel level, in layout order.
    /// Populated by VMenu via `onPreferenceChange(VMenuItemRegistrationKey.self)`.
    var itemOrder: [Int: [UUID]] = [:]

    /// Action closures for each item, keyed by (level, UUID).
    /// Invoked when Enter/Space is pressed on the focused item.
    var itemActions: [Int: [UUID: () -> Void]] = [:]

    /// Submenu-open closures for VSubMenuItems, keyed by (level, UUID).
    /// Invoked when → arrow is pressed on a focused submenu item.
    var submenuActions: [Int: [UUID: () -> Void]] = [:]

    /// Weak references to NSViews embedded in each item, for VoiceOver focus notifications.
    var itemNSViews: [Int: [UUID: WeakNSViewRef]] = [:]

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
        installKeyboardMonitor()

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
        removeKeyboardMonitor()
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
            removeKeyboardMonitor()
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

    /// Handle a key event. Returns `true` if consumed.
    ///
    /// Called from two sources:
    /// 1. The local key event monitor (primary path — bypasses the responder chain)
    /// 2. VMenuPanel.keyDown (fallback for any events the monitor misses)
    ///
    /// The local monitor approach matches how native `NSMenu` intercepts key events.
    /// Reference: [NSEvent.addLocalMonitorForEvents](https://developer.apple.com/documentation/appkit/nsevent/addlocalmonitorforevents(matching:handler:))
    func handleKeyDown(_ event: NSEvent) -> Bool {
        let level = panels.count - 1
        guard level >= 0 else { return false }

        // Record the time of this keyboard event so the mouse-move monitor
        // can ignore micro-movements that would immediately clear the focus.
        lastKeyboardEventTime = ProcessInfo.processInfo.systemUptime

        print("[VMenuKeyboard] handleKeyDown: keyCode=\(event.keyCode) level=\(level) panelCount=\(panels.count) itemCounts=\(itemCounts)")

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
        guard count > 0 else {
            print("[VMenuKeyboard] moveFocus: no items at level \(level), itemCounts=\(itemCounts), itemOrder keys=\(itemOrder.keys.sorted())")
            return
        }

        let current = focusedIndex[level] ?? (direction > 0 ? -1 : count)
        let next = (current + direction + count) % count
        focusedIndex[level] = next

        let focusedID = focusedItemID(at: level)
        print("[VMenuKeyboard] moveFocus: level=\(level) index=\(next) id=\(focusedID?.uuidString.prefix(8) ?? "nil") count=\(count)")

        // Notify VMenu via Combine (fallback path — primary path is .onKeyPress in VMenu)
        focusChangeSubject.send(focusedID)

        postVoiceOverFocusNotification(level: level)
    }

    /// Clear keyboard focus (switch back to mouse-driven interaction).
    func clearKeyboardFocus() {
        if !focusedIndex.isEmpty {
            print("[VMenuKeyboard] clearKeyboardFocus")
            focusedIndex.removeAll()
            // Signal VMenu to clear its @State focusedItemID
            clearFocusSubject.send()
        }
    }

    /// Record the time of a keyboard event (for mouse-move debounce).
    /// Called by VMenu's `.onKeyPress` handlers.
    func recordKeyboardEvent() {
        lastKeyboardEventTime = ProcessInfo.processInfo.systemUptime
    }

    // MARK: - VoiceOver Bridge

    /// Post an accessibility focus notification for the currently focused item,
    /// so VoiceOver tracks keyboard navigation.
    func postVoiceOverFocusNotification(level: Int) {
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

    // MARK: - Keyboard Monitor

    /// Install a local key event monitor that intercepts key-down events before the
    /// responder chain. This is the same approach native `NSMenu` uses to handle
    /// arrow keys, Enter, and Space — it works regardless of which window is key
    /// and bypasses `NSHostingView`'s internal key handling.
    ///
    /// Returning `nil` from the monitor consumes the event; returning the event lets
    /// it pass through to the normal responder chain.
    ///
    /// Reference: [NSEvent.addLocalMonitorForEvents](https://developer.apple.com/documentation/appkit/nsevent/addlocalmonitorforevents(matching:handler:))
    private func installKeyboardMonitor() {
        removeKeyboardMonitor()
        keyboardMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            // Track timing for mouse-move debounce but do NOT consume the event.
            // Let SwiftUI's .onKeyPress on VMenu handle it (primary path).
            // If VMenu doesn't have focus, the event falls through to
            // VMenuPanel.keyDown (fallback path).
            self?.lastKeyboardEventTime = ProcessInfo.processInfo.systemUptime
            return event
        }
    }

    private func removeKeyboardMonitor() {
        if let monitor = keyboardMonitor {
            NSEvent.removeMonitor(monitor)
            keyboardMonitor = nil
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
        if let monitor = keyboardMonitor {
            NSEvent.removeMonitor(monitor)
        }
    }
}
#endif
