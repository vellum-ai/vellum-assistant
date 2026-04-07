import SwiftUI

#if os(macOS)
import AppKit

// MARK: - Native Tooltip (NSView.toolTip — system delay ~1.5s)

/// Bridges AppKit's `NSView.toolTip` into SwiftUI via `.background()`.
///
/// AppKit tooltip tracking operates at the window level, independently of
/// SwiftUI's gesture system. This makes it reliable in views where `.help()`
/// fails due to competing tracking areas from gesture modifiers like
/// `.onTapGesture`, `.contextMenu`, `.onDrag`, and `.onHover`.
private struct NativeTooltipView: NSViewRepresentable {
    let text: String

    func makeNSView(context: Context) -> NSView {
        let view = NSView()
        view.toolTip = text
        return view
    }

    func updateNSView(_ nsView: NSView, context: Context) {
        nsView.toolTip = text
    }
}

public extension View {
    /// Attaches a native macOS tooltip via AppKit's `NSView.toolTip`.
    ///
    /// Prefer `.help()` for simple views. Use this modifier in views where
    /// SwiftUI gesture recognizers (`.onTapGesture`, `.contextMenu`, `.onDrag`)
    /// prevent `.help()` tooltips from appearing.
    func nativeTooltip(_ text: String) -> some View {
        self.background(NativeTooltipView(text: text))
    }
}

// MARK: - VTooltip Coordinator (singleton — manages the single tooltip panel)

/// Manages the lifecycle of a single `.vTooltip()` panel, matching native
/// macOS tooltip behavior where only one tooltip is ever visible.
///
/// All hover detection uses SwiftUI's `.onHover` modifier, which integrates
/// directly with SwiftUI's layout system and correctly handles:
/// - View recycling in LazyVStack / List / ScrollView
/// - `.opacity(0)`, `.hidden()`, `.allowsHitTesting(false)` on ancestors
/// - `.clipped()` boundaries
///
/// The coordinator owns:
/// - The tooltip NSPanel and its show/hide lifecycle
/// - A delayed-show timer (default 0.2 s)
/// - App-wide event monitors for dismiss-on-mouseDown and dismiss-on-keyDown
/// - NotificationCenter observers for scroll, window move/resize, app deactivate
private final class VTooltipCoordinator {
    static let shared = VTooltipCoordinator()
    private init() {
        installGlobalObservers()
    }

    private var panel: NSPanel?
    private var showTimer: Timer?
    private var activeText: String?

    // Event monitors (installed while tooltip is visible or pending)
    private var mouseDownMonitor: Any?
    private var keyDownMonitor: Any?

    // Global observers (always installed — lightweight NotificationCenter)
    private var scrollObserver: NSObjectProtocol?
    private var scrollEndObserver: NSObjectProtocol?
    private var appDeactivationObserver: NSObjectProtocol?
    private var windowMovedObserver: NSObjectProtocol?
    private var windowResizedObserver: NSObjectProtocol?

    /// Suppresses hover callbacks during and briefly after scroll so
    /// the tooltip doesn't flash while the content is settling.
    private var isScrolling = false

    // MARK: Public API (called from .onHover)

    /// Schedule a tooltip to show after `delay` seconds.
    /// Cancels any pending tooltip and dismisses the current one first.
    func scheduleShow(text: String, delay: TimeInterval) {
        cancelPending()
        dismissPanel()

        activeText = text
        showTimer = Timer.scheduledTimer(withTimeInterval: delay, repeats: false) { [weak self] _ in
            self?.showPanel()
        }
        installEventMonitors()
    }

    /// Called when `.onHover` reports `isHovering = false`.
    func hoverEnded() {
        cancelPending()
        dismissPanel()
    }

    /// Dismiss everything unconditionally. Used by event monitors and observers.
    func dismiss() {
        cancelPending()
        dismissPanel()
    }

    // MARK: Timer

    private func cancelPending() {
        showTimer?.invalidate()
        showTimer = nil
    }

    // MARK: Panel lifecycle

    private func showPanel() {
        guard let text = activeText else { return }
        guard !isScrolling else { return }

        // Find the key/main window to attach the tooltip to.
        guard let window = NSApplication.shared.keyWindow
            ?? NSApplication.shared.mainWindow
            ?? NSApplication.shared.windows.first(where: { $0.isVisible })
        else { return }

        let p = NSPanel(
            contentRect: .zero,
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: true
        )
        p.isOpaque = false
        p.backgroundColor = .clear
        p.level = .floating
        p.hasShadow = true
        p.ignoresMouseEvents = true

        let host = NSHostingView(rootView: VTooltipContent(text: text))
        host.frame.size = host.fittingSize
        p.contentView = host
        p.setContentSize(host.fittingSize)

        // Position relative to the mouse cursor (screen coordinates).
        // Using the cursor ensures the tooltip always appears near the
        // hovered item regardless of view recycling or scroll state.
        let mouse = NSEvent.mouseLocation
        let screen = NSScreen.screens.first { $0.frame.contains(mouse) }
            ?? window.screen ?? NSScreen.main
        let visibleFrame = screen?.visibleFrame ?? .zero
        let tooltipSize = host.fittingSize
        let gap: CGFloat = 2

        // Place just above the cursor; flip below if no room above.
        var x = mouse.x - tooltipSize.width / 2
        var y = mouse.y + gap

        if y + tooltipSize.height > visibleFrame.maxY {
            y = mouse.y - tooltipSize.height - gap
        }

        // Clamp to screen edges.
        x = max(x, visibleFrame.minX)
        x = min(x, visibleFrame.maxX - tooltipSize.width)
        y = max(y, visibleFrame.minY)
        y = min(y, visibleFrame.maxY - tooltipSize.height)

        p.setFrameOrigin(NSPoint(x: x, y: y))
        p.alphaValue = 0

        // Attach as a child window so the tooltip stays grouped with
        // its source window and doesn't float above unrelated windows.
        window.addChildWindow(p, ordered: .above)
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = 0.12
            p.animator().alphaValue = 1
        }
        panel = p
    }

    private func dismissPanel() {
        activeText = nil
        removeEventMonitors()

        guard let p = panel else { return }
        panel = nil

        if let parentWindow = p.parent {
            parentWindow.removeChildWindow(p)
        }
        NSAnimationContext.runAnimationGroup({ ctx in
            ctx.duration = 0.08
            p.animator().alphaValue = 0
        }, completionHandler: {
            p.orderOut(nil)
        })
    }

    // MARK: Event monitors (installed only while tooltip is pending/visible)

    private func installEventMonitors() {
        guard mouseDownMonitor == nil else { return }
        mouseDownMonitor = NSEvent.addLocalMonitorForEvents(
            matching: [.leftMouseDown, .rightMouseDown, .otherMouseDown]
        ) { [weak self] event in
            self?.dismiss()
            return event
        }
        keyDownMonitor = NSEvent.addLocalMonitorForEvents(
            matching: .keyDown
        ) { [weak self] event in
            self?.dismiss()
            return event
        }
    }

    private func removeEventMonitors() {
        if let monitor = mouseDownMonitor {
            NSEvent.removeMonitor(monitor)
            mouseDownMonitor = nil
        }
        if let monitor = keyDownMonitor {
            NSEvent.removeMonitor(monitor)
            keyDownMonitor = nil
        }
    }

    // MARK: Global observers (always installed — very lightweight)

    private func installGlobalObservers() {
        // Scroll: dismiss and suppress hover during scroll.
        scrollObserver = NotificationCenter.default.addObserver(
            forName: NSScrollView.willStartLiveScrollNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.isScrolling = true
            self?.dismiss()
        }
        scrollEndObserver = NotificationCenter.default.addObserver(
            forName: NSScrollView.didEndLiveScrollNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            // Brief delay so SwiftUI view positions settle before we
            // accept .onHover callbacks again.
            Task { @MainActor [weak self] in
                try? await Task.sleep(nanoseconds: 300_000_000)
                self?.isScrolling = false
            }
        }

        // App deactivation: dismiss immediately.
        appDeactivationObserver = NotificationCenter.default.addObserver(
            forName: NSApplication.didResignActiveNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.dismiss()
        }

        // Window move / resize: dismiss immediately.
        // Using `object: nil` to catch ALL windows.
        windowMovedObserver = NotificationCenter.default.addObserver(
            forName: NSWindow.didMoveNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.dismiss()
        }
        windowResizedObserver = NotificationCenter.default.addObserver(
            forName: NSWindow.didResizeNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.dismiss()
        }
    }
}

// MARK: - Fast Tooltip (NSPanel — custom delay, escapes clipping)

/// A floating tooltip that uses a non-activating `NSPanel` window.
///
/// Unlike `.help()` or `NSView.toolTip`, this tooltip:
/// - Shows after a configurable delay (default 0.2s, vs system's ~1.5s)
/// - Escapes parent `.clipShape()` boundaries (renders in its own window)
/// - Never steals clicks or interferes with hover/button states
/// - Works on any view: `VButton`, `Text`, `Image`, `HStack`, etc.
/// - Only one tooltip is visible at a time (coordinator-managed singleton)
/// - Correctly handles ScrollView / LazyVStack view recycling (uses
///   SwiftUI's `.onHover`, not `NSTrackingArea`)
/// - Clamps to screen bounds so the tooltip never goes off-screen
/// - Wraps long text at ~300 pt to match native tooltip max-width
/// - Dismisses on mouse-down, key-press, scroll, window move/resize,
///   and app deactivation (like native tooltips)
///
/// Usage:
/// ```swift
/// VButton(label: "Mic", iconOnly: VIcon.mic.rawValue, ...) { ... }
///     .vTooltip("Click to dictate")
///
/// Image(systemName: "info.circle")
///     .vTooltip("More information", delay: 0.4)
/// ```
public extension View {
    /// Attaches a floating tooltip that appears on hover after `delay` seconds.
    func vTooltip(_ text: String, edge: Edge = .top, delay: TimeInterval = 0.2) -> some View {
        self.onHover { isHovering in
            if isHovering {
                VTooltipCoordinator.shared.scheduleShow(text: text, delay: delay)
            } else {
                VTooltipCoordinator.shared.hoverEnded()
            }
        }
    }
}

// MARK: - Tooltip content view

private struct VTooltipContent: View {
    let text: String

    /// Maximum tooltip width matching native macOS tooltip behavior (~300 pt).
    /// Long text wraps to multiple lines instead of extending off-screen.
    private static let maxWidth: CGFloat = 300

    var body: some View {
        Text(text)
            .frame(maxWidth: Self.maxWidth, alignment: .leading)
            .fixedSize(horizontal: false, vertical: true)
            .font(VFont.labelDefault)
            .foregroundStyle(VColor.contentDefault)
            .padding(.horizontal, VSpacing.sm)
            .padding(.vertical, VSpacing.xs)
            .background(VColor.surfaceLift)
            .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
            .shadow(color: VColor.auxBlack.opacity(0.12), radius: 4, y: 2)
    }
}

#else
public extension View {
    /// On non-macOS platforms, falls back to the standard `.help()` modifier.
    func nativeTooltip(_ text: String) -> some View {
        self.help(text)
    }

    /// On non-macOS platforms, falls back to the standard `.help()` modifier.
    func vTooltip(_ text: String, edge: Edge = .top, delay: TimeInterval = 0.2) -> some View {
        self.help(text)
    }
}
#endif
