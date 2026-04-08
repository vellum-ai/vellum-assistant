#if os(macOS)
import SwiftUI
import AppKit

// MARK: - VMenuPanel

/// A borderless, floating NSPanel that hosts a SwiftUI `VMenu` at a given
/// screen position. Dismisses automatically on click-outside or Escape.
///
/// Typically you don't create this directly — use the `.vContextMenu` modifier.
public class VMenuPanel: NSPanel {
    private var dismissHandler: (() -> Void)?
    private var clickMonitor: Any?
    weak var coordinator: VMenuCoordinator?
    private var managedByCoordinator: Bool = false
    /// Guard to prevent recursive coordinator notification from `close()`.
    private var isClosingFromCoordinator: Bool = false

    /// Extra padding added around the VMenu content so its shadow can render
    /// without being clipped by the hosting view's bounds.
    public static let shadowInset: CGFloat = 14

    /// Show SwiftUI content in a floating panel at the given screen point.
    ///
    /// Creates a `VMenuCoordinator` internally so submenu support is always available.
    /// Existing callers don't need to change — the coordinator is an implementation detail.
    ///
    /// - Parameters:
    ///   - screenPoint: Cursor position in screen coordinates.
    ///   - sourceWindow: The window the menu was opened from. When provided, this is
    ///     used as the parent window for `addChildWindow(_:ordered:)`. When `nil`,
    ///     the source window is inferred from the topmost window containing
    ///     `screenPoint` (front-to-back via `NSApp.orderedWindows`). Callers that
    ///     already know which window owns the trigger (e.g. `VDropdown`) should
    ///     pass it explicitly to avoid the geometric heuristic picking the wrong
    ///     window when multiple app windows overlap the click point.
    ///   - sourceAppearance: The source window's appearance for correct color resolution.
    ///   - content: The SwiftUI view to display (typically a `VMenu`).
    ///   - onDismiss: Called when the panel is dismissed for any reason.
    /// - Returns: The panel instance (store it to keep the panel alive).
    @discardableResult
    public static func show<Content: View>(
        at screenPoint: CGPoint,
        sourceWindow: NSWindow? = nil,
        sourceAppearance: NSAppearance? = nil,
        excludeRect: CGRect? = nil,
        @ViewBuilder content: () -> Content,
        onDismiss: @escaping () -> Void
    ) -> VMenuPanel {
        let panel = VMenuPanel(
            contentRect: .zero,
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: true
        )
        // isFloatingPanel sets level to .floating by default — do not
        // override with .popUpMenu, which is level 101 and causes the panel
        // to render above *all* windows on the desktop, including other apps.
        // See: https://developer.apple.com/documentation/appkit/nswindow/level
        panel.isFloatingPanel = true
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        // Enable mouse-moved events so the coordinator's local monitor can detect
        // mouse movement over the panel and clear keyboard focus appropriately.
        panel.acceptsMouseMovedEvents = true

        // Accessibility: configure the panel so VoiceOver can navigate its SwiftUI content.
        // - Role description "menu" preserves the announcement without the behavioral
        //   implications of setAccessibilityRole(.menu), which expects native NSMenu-style
        //   .menuItem children that SwiftUI can't provide.
        // - Subrole .standardWindow prevents VoiceOver from treating it as "system dialog"
        //   which blocks direct item navigation.
        panel.setAccessibilityRoleDescription(NSLocalizedString("menu", comment: "Accessibility role description for VMenu panel"))
        panel.setAccessibilitySubrole(.standardWindow)

        // Create coordinator for this panel tree
        let coordinator = VMenuCoordinator()
        panel.coordinator = coordinator
        panel.managedByCoordinator = true

        if let appearance = sourceAppearance {
            panel.appearance = appearance
        }

        // Inject coordinator, panel level, and dismiss closure into environment.
        let paddedContent = content()
            .environment(\.vMenuDismiss, { [weak coordinator] in coordinator?.dismissAll() })
            .environment(\.vMenuCoordinator, coordinator)
            .environment(\.vMenuPanelLevel, 0)
            .padding(Self.shadowInset)
        // Use NSHostingView directly as contentView — no FirstMouseView wrapper.
        // This preserves the natural NSPanel → NSHostingView → SwiftUI accessibility
        // hierarchy that VoiceOver needs for both navigation and action activation.
        // The panel is .nonactivatingPanel with canBecomeKey=true, so clicks are
        // processed immediately without needing acceptsFirstMouse.
        let hostingView = NSHostingView(rootView: paddedContent)
        hostingView.sizingOptions = [.intrinsicContentSize]
        panel.contentView = hostingView

        let fittingSize = hostingView.fittingSize
        let menuSize = CGSize(
            width: max(fittingSize.width, 1),
            height: max(fittingSize.height, 1)
        )

        let origin = clampedOrigin(for: menuSize, cursorAt: screenPoint)
        panel.setFrame(CGRect(origin: origin, size: menuSize), display: true)

        // Resolve the parent window for child-window attachment. Prefer the
        // explicit `sourceWindow` passed by the caller — they know which
        // window owns the trigger. Fall back to a front-to-back geometric
        // search when no source is provided (e.g. `vContextMenu`). We use
        // `orderedWindows` (z-order) rather than `windows` (creation order)
        // so the topmost window containing the click point wins; otherwise
        // an older window stacked behind a newer modal would be picked up
        // and `addChildWindow` would shove the modal behind it.
        let resolvedSourceWindow: NSWindow? = sourceWindow ?? NSApp.orderedWindows.first(where: {
            $0.isVisible && $0.frame.contains(screenPoint) && !($0 is VMenuPanel)
        })

        panel.makeKeyAndOrderFront(nil)

        // Attach as a child window so the menu stays grouped with its
        // parent and doesn't float above unrelated windows from other apps.
        // See: https://developer.apple.com/documentation/appkit/nswindow/addchildwindow(_:ordered:)
        if let resolvedSourceWindow {
            resolvedSourceWindow.addChildWindow(panel, ordered: .above)
        }

        // Register with coordinator — it installs the unified click monitor
        coordinator.registerRootPanel(panel, sourceWindow: resolvedSourceWindow, excludeRect: excludeRect, onDismiss: onDismiss)

        // Notify VoiceOver that a new menu appeared so it navigates into it.
        DispatchQueue.main.async {
            NSAccessibility.post(element: panel, notification: .created)
            if let firstChild = hostingView.accessibilityChildren()?.first {
                NSAccessibility.post(element: firstChild, notification: .focusedUIElementChanged)
            } else {
                NSAccessibility.post(element: hostingView, notification: .focusedUIElementChanged)
            }
        }

        return panel
    }

    /// Show a child panel anchored to a parent menu item's screen rect.
    ///
    /// Managed by a `VMenuCoordinator` — no per-panel click monitor is installed.
    /// Mouse-enter on the child cancels the coordinator's grace timer.
    static func showAnchored<Content: View>(
        to itemRect: CGRect,
        sourceAppearance: NSAppearance?,
        coordinator: VMenuCoordinator,
        @ViewBuilder content: () -> Content
    ) -> VMenuPanel {
        let panel = VMenuPanel(
            contentRect: .zero,
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: true
        )
        panel.isFloatingPanel = true
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.acceptsMouseMovedEvents = true
        panel.setAccessibilityRoleDescription(NSLocalizedString("menu", comment: "Accessibility role description for VMenu panel"))
        panel.setAccessibilitySubrole(.standardWindow)
        panel.coordinator = coordinator
        panel.managedByCoordinator = true

        if let appearance = sourceAppearance {
            panel.appearance = appearance
        }

        let childLevel = coordinator.panels.count
        let paddedContent = content()
            .environment(\.vMenuDismiss, { [weak coordinator] in coordinator?.dismissAll() })
            .environment(\.vMenuCoordinator, coordinator)
            .environment(\.vMenuPanelLevel, childLevel)
            .padding(Self.shadowInset)
            .onHover { hovering in
                if hovering {
                    coordinator.cancelGraceTimer()
                } else {
                    coordinator.startGraceTimer()
                }
            }

        let hostingView = NSHostingView(rootView: paddedContent)
        hostingView.sizingOptions = [.intrinsicContentSize]
        panel.contentView = hostingView

        let fittingSize = hostingView.fittingSize
        let menuSize = CGSize(
            width: max(fittingSize.width, 1),
            height: max(fittingSize.height, 1)
        )

        let origin = anchoredOrigin(for: menuSize, anchorRect: itemRect)
        panel.setFrame(CGRect(origin: origin, size: menuSize), display: true)
        panel.makeKeyAndOrderFront(nil)

        // Notify VoiceOver that a new submenu appeared.
        DispatchQueue.main.async {
            NSAccessibility.post(element: panel, notification: .created)
            if let firstChild = hostingView.accessibilityChildren()?.first {
                NSAccessibility.post(element: firstChild, notification: .focusedUIElementChanged)
            } else {
                NSAccessibility.post(element: hostingView, notification: .focusedUIElementChanged)
            }
        }

        return panel
    }

    // MARK: - Positioning

    /// Calculate panel origin clamped to the visible bounds of the screen containing the cursor.
    private static func clampedOrigin(for size: CGSize, cursorAt cursor: CGPoint) -> CGPoint {
        let screen = NSScreen.screens.first(where: { $0.frame.contains(cursor) })?.visibleFrame
            ?? NSScreen.main?.visibleFrame
            ?? .zero

        var x = cursor.x - shadowInset
        var y = cursor.y - size.height + shadowInset

        if x + size.width > screen.maxX {
            x = cursor.x - size.width + shadowInset
        }
        if x < screen.minX {
            x = screen.minX
        }
        if y < screen.minY {
            y = cursor.y - shadowInset
        }
        if y + size.height > screen.maxY {
            y = screen.maxY - size.height
        }

        return CGPoint(x: x, y: y)
    }

    /// Calculate child panel origin anchored to a parent item's screen rect.
    /// Positions the child's visual left edge flush with the anchor's right edge,
    /// top-aligned with the anchor item. Flips to leading edge on right overflow.
    private static func anchoredOrigin(for size: CGSize, anchorRect: CGRect) -> CGPoint {
        let screen = NSScreen.screens.first(where: { $0.frame.contains(anchorRect.origin) })?.visibleFrame
            ?? NSScreen.main?.visibleFrame
            ?? .zero

        // The child panel has `shadowInset` padding on all sides. To align
        // the child's VISUAL left edge with the anchor's right edge, offset
        // the panel origin left by shadowInset.
        var x = anchorRect.maxX - shadowInset
        // Align child's visual top with anchor's top.
        // macOS y-axis is bottom-up: anchorRect.maxY is the top edge.
        // The child's visual top is at panel.origin.y + size.height - shadowInset.
        var y = anchorRect.maxY - size.height + shadowInset

        // Right overflow: flip to left side of anchor
        if x + size.width > screen.maxX {
            x = anchorRect.minX - size.width + shadowInset
        }
        // Left overflow
        if x < screen.minX {
            x = screen.minX
        }
        // Bottom overflow
        if y < screen.minY {
            y = screen.minY
        }
        // Top overflow
        if y + size.height > screen.maxY {
            y = screen.maxY - size.height
        }

        return CGPoint(x: x, y: y)
    }

    // MARK: - Close

    /// Called by the coordinator to close this panel without triggering a recursive notification.
    func closeFromCoordinator() {
        isClosingFromCoordinator = true
        close()
        isClosingFromCoordinator = false
    }

    public override func close() {
        clickMonitor.flatMap(NSEvent.removeMonitor)
        clickMonitor = nil

        // Detach from parent window before closing so the parent's
        // child window list stays clean.
        if let parentWindow = parent {
            parentWindow.removeChildWindow(self)
        }

        let handler = dismissHandler
        dismissHandler = nil

        super.close()

        if managedByCoordinator && !isClosingFromCoordinator {
            coordinator?.panelWasClosed(self)
        } else if !managedByCoordinator {
            handler?()
        }
    }

    public override func cancelOperation(_ sender: Any?) {
        if managedByCoordinator, let coordinator {
            if coordinator.hasChild && self === coordinator.panels.last {
                coordinator.dismissChild()
            } else {
                coordinator.dismissAll()
            }
        } else {
            close()
        }
    }

    // MARK: - Keyboard (M3)

    public override func keyDown(with event: NSEvent) {
        if let coordinator, coordinator.handleKeyDown(event) {
            return
        }
        super.keyDown(with: event)
    }

    public override var canBecomeKey: Bool { true }
    public override var canBecomeMain: Bool { false }

}


// MARK: - .vContextMenu modifier

public extension View {
    /// Attaches a custom context menu using `VMenu` that appears on right-click.
    ///
    /// Menu items (`VMenuItem`) automatically dismiss the menu when tapped.
    /// Supports `VSubMenuItem` for cascading submenus.
    ///
    /// Usage:
    /// ```swift
    /// Text("Hello")
    ///     .vContextMenu {
    ///         VMenuItem(icon: VIcon.copy.rawValue, label: "Copy") { handleCopy() }
    ///         VMenuDivider()
    ///         VMenuItem(icon: VIcon.trash.rawValue, label: "Delete") { handleDelete() }
    ///     }
    /// ```
    func vContextMenu<Content: View>(
        width: CGFloat? = nil,
        @ViewBuilder content: @escaping () -> Content
    ) -> some View {
        modifier(VContextMenuModifier(menuWidth: width, menuContent: content))
    }
}

private struct VContextMenuModifier<MenuContent: View>: ViewModifier {
    let menuWidth: CGFloat?
    @ViewBuilder let menuContent: () -> MenuContent

    /// Weak reference avoids retain cycles — the window server keeps the panel
    /// alive while it's visible; we only need this to close on re-open.
    @State private var panelRef = WeakPanel()

    func body(content: Content) -> some View {
        content
            .onRightClick { screenPoint in
                // Close any existing panel synchronously before creating a new one.
                // Nil the ref first so the old panel's onDismiss doesn't race.
                let oldPanel = panelRef.value
                panelRef.value = nil
                oldPanel?.close()

                // Capture appearance from the window under the cursor at click time.
                // Use `orderedWindows` (front-to-back z-order) so we pick the topmost
                // window the click landed in — `NSApp.windows` is creation order and
                // can return an older window stacked behind a newer one.
                let appearance = NSApp.orderedWindows
                    .first(where: { $0.isVisible && $0.frame.contains(screenPoint) })?
                    .effectiveAppearance

                let newPanel = VMenuPanel.show(
                    at: screenPoint,
                    sourceAppearance: appearance
                ) {
                    VMenu(width: menuWidth) {
                        menuContent()
                    }
                } onDismiss: { [weak panelRef] in
                    panelRef?.value = nil
                }
                panelRef.value = newPanel
            }
    }
}

/// Weak box for VMenuPanel so @State doesn't create a strong retain cycle
/// with the panel's dismiss handler.
private class WeakPanel {
    weak var value: VMenuPanel?
}
#endif
