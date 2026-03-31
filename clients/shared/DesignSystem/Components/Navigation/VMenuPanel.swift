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

    /// Extra padding added around the VMenu content so its shadow can render
    /// without being clipped by the hosting view's bounds.
    static let shadowInset: CGFloat = 14

    /// Show SwiftUI content in a floating panel at the given screen point.
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
        panel.dismissHandler = onDismiss

        if let appearance = sourceAppearance {
            panel.appearance = appearance
        }

        // Inject auto-dismiss environment and add shadow padding.
        // The dismiss closure captures `panel` (a local var) directly —
        // NOT the caller's @State, which wouldn't be assigned yet.
        let paddedContent = content()
            .environment(\.vMenuDismiss, { [weak panel] in panel?.close() })
            .padding(Self.shadowInset)
        let hostingView = NSHostingView(rootView: paddedContent)
        hostingView.sizingOptions = [.intrinsicContentSize]

        // Wrap in FirstMouseView so clicks register immediately
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

        // Size and position — fittingSize is more reliable than intrinsicContentSize
        // which can return NSView.noIntrinsicMetric (-1) before layout settles.
        let fittingSize = hostingView.fittingSize
        let menuSize = CGSize(
            width: max(fittingSize.width, 1),
            height: max(fittingSize.height, 1)
        )

        // Clamp to screen bounds so the menu doesn't go off-screen
        let origin = panel.clampedOrigin(for: menuSize, cursorAt: screenPoint)
        panel.setFrame(CGRect(origin: origin, size: menuSize), display: true)
        panel.makeKeyAndOrderFront(nil)

        // Click-outside dismissal (async to skip the opening right-click)
        DispatchQueue.main.async {
            panel.clickMonitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { event in
                let locationInPanel = panel.convertPoint(fromScreen: NSEvent.mouseLocation)
                let panelBounds = panel.contentView?.bounds ?? .zero
                if panelBounds.contains(locationInPanel) {
                    return event
                }
                // Skip dismiss if click is in the trigger's excluded rect — let the
                // trigger button handle closing so it doesn't immediately reopen.
                if let excludeRect, excludeRect.contains(NSEvent.mouseLocation) {
                    return event
                }
                panel.close()
                return event
            }
        }

        return panel
    }

    /// Calculate panel origin clamped to the visible bounds of the screen containing the cursor.
    private func clampedOrigin(for size: CGSize, cursorAt cursor: CGPoint) -> CGPoint {
        let screen = NSScreen.screens.first(where: { $0.frame.contains(cursor) })?.visibleFrame
            ?? NSScreen.main?.visibleFrame
            ?? .zero

        // Default: menu top-left at cursor, growing down-right.
        // Offset by shadowInset so the VMenu's visual edge aligns with the cursor.
        var x = cursor.x - Self.shadowInset
        var y = cursor.y - size.height + Self.shadowInset

        // Clamp right edge
        if x + size.width > screen.maxX {
            x = cursor.x - size.width + Self.shadowInset
        }
        // Clamp left edge
        if x < screen.minX {
            x = screen.minX
        }
        // Clamp bottom edge — flip upward if needed
        if y < screen.minY {
            y = cursor.y - Self.shadowInset
        }
        // Clamp top edge
        if y + size.height > screen.maxY {
            y = screen.maxY - size.height
        }

        return CGPoint(x: x, y: y)
    }

    public override func close() {
        clickMonitor.flatMap(NSEvent.removeMonitor)
        clickMonitor = nil
        dismissHandler?()
        dismissHandler = nil
        super.close()
    }

    public override func cancelOperation(_ sender: Any?) {
        close()
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
