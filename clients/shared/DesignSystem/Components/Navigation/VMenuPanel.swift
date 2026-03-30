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
    static let shadowInset: CGFloat = 14

    /// Show SwiftUI content in a floating panel at the given screen point.
    ///
    /// Creates a `VMenuCoordinator` internally so submenu support is always available.
    /// Existing callers don't need to change — the coordinator is an implementation detail.
    ///
    /// - Parameters:
    ///   - screenPoint: Cursor position in screen coordinates.
    ///   - sourceAppearance: The source window's appearance for correct color resolution.
    ///   - content: The SwiftUI view to display (typically a `VMenu`).
    ///   - onDismiss: Called when the panel is dismissed for any reason.
    /// - Returns: The panel instance (store it to keep the panel alive).
    @discardableResult
    public static func show<Content: View>(
        at screenPoint: CGPoint,
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
        panel.isFloatingPanel = true
        panel.level = .popUpMenu
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false

        // Create coordinator for this panel tree
        let coordinator = VMenuCoordinator()
        panel.coordinator = coordinator
        panel.managedByCoordinator = true

        if let appearance = sourceAppearance {
            panel.appearance = appearance
        }

        // Inject coordinator and dismiss closure into environment.
        let paddedContent = content()
            .environment(\.vMenuDismiss, { [weak coordinator] in coordinator?.dismissAll() })
            .environment(\.vMenuCoordinator, coordinator)
            .padding(Self.shadowInset)
        let hostingView = NSHostingView(rootView: paddedContent)
        hostingView.sizingOptions = [.intrinsicContentSize]

        let container = FirstMouseView()
        container.wantsLayer = true
        container.layer?.backgroundColor = .clear

        hostingView.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(hostingView)
        NSLayoutConstraint.activate([
            hostingView.topAnchor.constraint(equalTo: container.topAnchor),
            hostingView.bottomAnchor.constraint(equalTo: container.bottomAnchor),
            hostingView.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            hostingView.trailingAnchor.constraint(equalTo: container.trailingAnchor),
        ])
        panel.contentView = container

        let fittingSize = hostingView.fittingSize
        let menuSize = CGSize(
            width: max(fittingSize.width, 1),
            height: max(fittingSize.height, 1)
        )

        let origin = clampedOrigin(for: menuSize, cursorAt: screenPoint)
        panel.setFrame(CGRect(origin: origin, size: menuSize), display: true)
        panel.makeKeyAndOrderFront(nil)

        // Register with coordinator — it installs the unified click monitor
        let sourceWindow = NSApp.windows.first(where: { $0.frame.contains(screenPoint) && !($0 is VMenuPanel) })
        coordinator.registerRootPanel(panel, sourceWindow: sourceWindow, excludeRect: excludeRect, onDismiss: onDismiss)

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
        panel.level = .popUpMenu
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.coordinator = coordinator
        panel.managedByCoordinator = true

        if let appearance = sourceAppearance {
            panel.appearance = appearance
        }

        let paddedContent = content()
            .environment(\.vMenuDismiss, { [weak coordinator] in coordinator?.dismissAll() })
            .environment(\.vMenuCoordinator, coordinator)
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

        let container = FirstMouseView()
        container.wantsLayer = true
        container.layer?.backgroundColor = .clear

        hostingView.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(hostingView)
        NSLayoutConstraint.activate([
            hostingView.topAnchor.constraint(equalTo: container.topAnchor),
            hostingView.bottomAnchor.constraint(equalTo: container.bottomAnchor),
            hostingView.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            hostingView.trailingAnchor.constraint(equalTo: container.trailingAnchor),
        ])
        panel.contentView = container

        let fittingSize = hostingView.fittingSize
        let menuSize = CGSize(
            width: max(fittingSize.width, 1),
            height: max(fittingSize.height, 1)
        )

        let origin = anchoredOrigin(for: menuSize, anchorRect: itemRect)
        panel.setFrame(CGRect(origin: origin, size: menuSize), display: true)
        panel.makeKeyAndOrderFront(nil)

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

// MARK: - FirstMouseView

/// Container view that accepts first-mouse clicks so taps work immediately
/// in a floating panel without requiring a focus click first.
class FirstMouseView: NSView {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
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

                // Capture appearance from the window under the cursor at click time
                let appearance = NSApp.windows
                    .first(where: { $0.frame.contains(screenPoint) })?
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
