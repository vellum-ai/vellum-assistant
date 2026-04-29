#if os(macOS)
import SwiftUI
import AppKit

// MARK: - VMenuAnchorEdge

/// Controls whether a VMenuPanel appears below or above the anchor point.
public enum VMenuAnchorEdge {
    /// Menu top aligns with the anchor point, extending downward (default).
    case below
    /// Menu bottom aligns with the anchor point, extending upward.
    case above
}

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

    /// The currently active root-level menu panel. Only one root panel should
    /// be visible at a time, matching native NSMenu behavior. Child panels
    /// (submenus via showAnchored) are managed by the coordinator, not here.
    private static weak var activeRootPanel: VMenuPanel?

    /// Extra padding added around the VMenu content so its shadow can render
    /// without being clipped by the hosting view's bounds.
    static let shadowInset: CGFloat = 14

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
        anchor: VMenuAnchorEdge = .below,
        sourceWindow: NSWindow? = nil,
        sourceAppearance: NSAppearance? = nil,
        excludeRect: CGRect? = nil,
        @ViewBuilder content: () -> Content,
        onDismiss: @escaping () -> Void
    ) -> VMenuPanel {
        // Dismiss ALL existing VMenuPanel trees before showing a new one.
        // This matches NSMenu's native behavior: only one menu visible at a time.
        //
        // We sweep NSApp.windows instead of relying solely on the
        // activeRootPanel weak reference. If a panel's last strong
        // Swift reference is released without calling close() (e.g., due
        // to SwiftUI view recreation or @State reset), the weak ref
        // becomes nil but the panel remains on screen — the window
        // server retains ordered-in windows independently of ARC.
        // The sweep catches these orphaned panels.
        for window in NSApp.windows {
            guard let existing = window as? VMenuPanel, existing.isVisible else { continue }
            if let coordinator = existing.coordinator {
                coordinator.dismissAll()
            } else {
                existing.close()
            }
        }

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
        // ARC manages the panel lifetime — disable AppKit's legacy
        // release-on-close which adds an extra release() call inside
        // super.close() and can conflict with ARC reference counting.
        // Reference: https://developer.apple.com/documentation/appkit/nswindow/isreleasedwhenclosed
        panel.isReleasedWhenClosed = false
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

        // Force a full layout pass so the SwiftUI content is correctly measured.
        // invalidateIntrinsicContentSize() marks the cached size as stale;
        // layoutSubtreeIfNeeded() then forces a synchronous recomputation.
        // Without both, NSHostingView may occasionally return a fittingSize
        // that only reflects the VMenu chrome (background + shadow inset)
        // without accounting for the actual menu items.
        hostingView.invalidateIntrinsicContentSize()
        hostingView.layoutSubtreeIfNeeded()

        let fittingSize = hostingView.fittingSize
        let menuSize = CGSize(
            width: max(fittingSize.width, 1),
            height: max(fittingSize.height, 1)
        )

        // Disable intrinsic-content-size-based resizing now that we have the
        // correct size. On macOS 13.3+, NSHostingView re-advertises its
        // SwiftUI content's intrinsic size to the containing window on every
        // layout pass. If SwiftUI re-lays out (e.g. focus changes via .task),
        // the intrinsic size can temporarily diverge from fittingSize, causing
        // the panel to shrink to near-zero — producing a ghost shadow artifact
        // with no visible content. Setting sizingOptions to empty makes our
        // explicit setFrame the single source of truth for panel geometry.
        // Reference: https://mjtsai.com/blog/2023/08/03/how-nshostingview-determines-its-sizing/
        hostingView.sizingOptions = []

        let origin = clampedOrigin(for: menuSize, cursorAt: screenPoint, anchor: anchor)
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

        // Show the panel invisible initially. SwiftUI's rendering pipeline
        // may split into two phases — background/shadow first, then text —
        // producing a 1-frame flash of an empty rounded rect with shadow
        // (the "ghost"). Holding alpha at 0 until the next run-loop cycle
        // guarantees SwiftUI has completed its first full render pass before
        // the panel becomes visible.
        panel.alphaValue = 0
        panel.makeKeyAndOrderFront(nil)

        // Attach as a child window so the menu stays grouped with its
        // parent and doesn't float above unrelated windows from other apps.
        // See: https://developer.apple.com/documentation/appkit/nswindow/addchildwindow(_:ordered:)
        if let resolvedSourceWindow {
            resolvedSourceWindow.addChildWindow(panel, ordered: .above)
        }

        // Register with coordinator — it installs the unified click monitor
        coordinator.registerRootPanel(panel, sourceWindow: resolvedSourceWindow, excludeRect: excludeRect, onDismiss: onDismiss)

        // Reveal the panel after SwiftUI has completed its full render pass.
        // A single run-loop cycle is sometimes insufficient — SwiftUI's
        // Metal-backed rendering pipeline can split across 2+ frames
        // (background/shadow first, then text layout). Double-pumping
        // the main queue ensures both phases complete before reveal.
        // Guard on contentView != nil rather than isVisible: contentView
        // is set to nil synchronously in close(), making it a reliable
        // indicator that the panel has been dismissed.
        DispatchQueue.main.async { [weak panel] in
            DispatchQueue.main.async { [weak panel] in
                guard let panel, panel.contentView != nil else { return }
                panel.alphaValue = 1
                NSAccessibility.post(element: panel, notification: .created)
                if let contentView = panel.contentView,
                   let firstChild = contentView.accessibilityChildren()?.first {
                    NSAccessibility.post(element: firstChild, notification: .focusedUIElementChanged)
                } else if let contentView = panel.contentView {
                    NSAccessibility.post(element: contentView, notification: .focusedUIElementChanged)
                }
            }
        }

        activeRootPanel = panel

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
        panel.isReleasedWhenClosed = false
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

        hostingView.invalidateIntrinsicContentSize()
        hostingView.layoutSubtreeIfNeeded()

        let fittingSize = hostingView.fittingSize
        let menuSize = CGSize(
            width: max(fittingSize.width, 1),
            height: max(fittingSize.height, 1)
        )

        // Lock panel geometry — see comment in show() for rationale.
        hostingView.sizingOptions = []

        let origin = anchoredOrigin(for: menuSize, anchorRect: itemRect)
        panel.setFrame(CGRect(origin: origin, size: menuSize), display: true)
        // Fade-in guard — same rationale as show().
        panel.alphaValue = 0
        panel.makeKeyAndOrderFront(nil)

        DispatchQueue.main.async { [weak panel] in
            DispatchQueue.main.async { [weak panel] in
                guard let panel, panel.contentView != nil else { return }
                panel.alphaValue = 1
                NSAccessibility.post(element: panel, notification: .created)
                if let contentView = panel.contentView,
                   let firstChild = contentView.accessibilityChildren()?.first {
                    NSAccessibility.post(element: firstChild, notification: .focusedUIElementChanged)
                } else if let contentView = panel.contentView {
                    NSAccessibility.post(element: contentView, notification: .focusedUIElementChanged)
                }
            }
        }

        return panel
    }

    // MARK: - Positioning

    /// Calculate panel origin clamped to the visible bounds of the screen containing the cursor.
    private static func clampedOrigin(for size: CGSize, cursorAt cursor: CGPoint, anchor: VMenuAnchorEdge = .below) -> CGPoint {
        let screen = NSScreen.screens.first(where: { $0.frame.contains(cursor) })?.visibleFrame
            ?? NSScreen.main?.visibleFrame
            ?? .zero

        var x = cursor.x - shadowInset

        // Horizontal overflow
        if x + size.width > screen.maxX {
            x = cursor.x - size.width + shadowInset
        }
        if x < screen.minX {
            x = screen.minX
        }

        // Vertical positioning with flip-then-clamp
        let belowY = cursor.y - size.height + shadowInset
        let aboveY = cursor.y - shadowInset
        var y: CGFloat

        switch anchor {
        case .below:
            y = belowY
            // Overflows bottom → try flipping above
            if y < screen.minY {
                y = aboveY
            }
        case .above:
            y = aboveY
            // Overflows top → try flipping below
            if y + size.height > screen.maxY {
                y = belowY
            }
        }

        // Final clamp to screen bounds
        if y + size.height > screen.maxY {
            y = screen.maxY - size.height
        }
        if y < screen.minY {
            y = screen.minY
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
        if self === VMenuPanel.activeRootPanel {
            VMenuPanel.activeRootPanel = nil
        }

        // Capture the coordinator before releasing contentView.
        // The NSHostingView (contentView) holds the only strong
        // reference to the coordinator via the SwiftUI environment.
        // The panel's `coordinator` property is weak, so releasing
        // contentView would deallocate the coordinator before
        // panelWasClosed() can fire.
        let coord = coordinator

        // 1. Make invisible + strip SwiftUI content in one
        //    synchronous block so the compositor never sees a
        //    "transparent window with a shadow backing-store" frame.
        alphaValue = 0
        contentView = nil

        // 2. Detach from parent BEFORE ordering out. Child windows
        //    are re-ordered when their parent orders front
        //    (https://developer.apple.com/documentation/appkit/nswindow/addchildwindow(_:ordered:)).
        //    If the parent processes a click-through between orderOut
        //    and removeChildWindow, it could briefly re-order this
        //    panel back on screen.
        if let parentWindow = parent {
            parentWindow.removeChildWindow(self)
        }

        // 3. Explicitly order out before super.close() so the
        //    window server removes the surface immediately rather
        //    than waiting for the close→orderOut path which can
        //    leave a stale compositor entry for one frame.
        orderOut(nil)

        clickMonitor.flatMap(NSEvent.removeMonitor)
        clickMonitor = nil

        let handler = dismissHandler
        dismissHandler = nil

        super.close()

        if managedByCoordinator && !isClosingFromCoordinator {
            coord?.panelWasClosed(self)
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
