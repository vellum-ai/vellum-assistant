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

// MARK: - VTooltip Coordinator (singleton — one tooltip at a time)

/// Ensures only one `.vTooltip()` panel is visible at any time, matching
/// native macOS tooltip behavior where the system never shows multiple
/// tooltips simultaneously.
private final class VTooltipCoordinator {
    static let shared = VTooltipCoordinator()
    private init() {}

    /// The tracker view that currently owns the visible tooltip.
    /// Weak so we don't prevent deallocation of removed views.
    private(set) weak var activeTracker: VTooltipTrackerView?

    /// Register a tracker as the active tooltip owner, dismissing any
    /// previously active tooltip first.
    func activate(_ tracker: VTooltipTrackerView) {
        if let previous = activeTracker, previous !== tracker {
            previous.dismissTooltip()
        }
        activeTracker = tracker
    }

    /// Clear the active tracker if it matches the given view.
    func deactivate(_ tracker: VTooltipTrackerView) {
        if activeTracker === tracker {
            activeTracker = nil
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
/// - Won't show if the source view or any ancestor is hidden, fully
///   transparent, or zero-sized (e.g., sidebar behind the settings panel)
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
        self.overlay(
            VTooltipTracker(text: text, edge: edge, delay: delay)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .allowsHitTesting(false)
        )
    }
}

/// NSViewRepresentable that installs a tracking area on an invisible NSView.
/// On mouse enter (after delay), shows a floating tooltip panel positioned
/// using AppKit's native coordinate conversion.
private struct VTooltipTracker: NSViewRepresentable {
    let text: String
    let edge: Edge
    let delay: TimeInterval

    func makeNSView(context: Context) -> VTooltipTrackerView {
        let view = VTooltipTrackerView()
        view.tooltipText = text
        view.tooltipEdge = edge
        view.showDelay = delay
        return view
    }

    func updateNSView(_ nsView: VTooltipTrackerView, context: Context) {
        nsView.tooltipText = text
        nsView.tooltipEdge = edge
        nsView.showDelay = delay
    }
}

/// Invisible NSView that tracks mouse hover and shows a tooltip panel.
/// Returns `nil` from `hitTest` so all mouse events pass through to the
/// view underneath. The tooltip panel uses `ignoresMouseEvents = true`
/// so it never interferes with interaction.
///
/// Coordinates with `VTooltipCoordinator` so only one tooltip is visible
/// at a time. Before showing, checks `isEffectivelyVisible` to suppress
/// tooltips for views that are hidden, fully transparent, or inside a
/// zero-sized ancestor (e.g., sidebar behind the settings panel).
private final class VTooltipTrackerView: NSView {
    var tooltipText: String = ""
    var tooltipEdge: Edge = .top
    var showDelay: TimeInterval = 0.2
    private var showTimer: Timer?
    private var panel: NSPanel?
    private var scrollObserver: NSObjectProtocol?
    private var scrollEndObserver: NSObjectProtocol?
    private var appDeactivationObserver: NSObjectProtocol?

    /// Suppresses synthetic mouseEntered events during and briefly after scroll.
    /// Static because the re-entry can hit a different VTooltipTrackerView instance
    /// than the one that was dismissed.
    private static var isScrolling = false

    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        trackingAreas.forEach { removeTrackingArea($0) }
        addTrackingArea(NSTrackingArea(
            rect: bounds,
            options: [.mouseEnteredAndExited, .activeInActiveApp],
            owner: self
        ))
    }

    override func mouseEntered(with event: NSEvent) {
        guard !Self.isScrolling else { return }
        showTimer?.invalidate()
        showTimer = Timer.scheduledTimer(withTimeInterval: showDelay, repeats: false) { [weak self] _ in
            guard let self, self.isEffectivelyVisible else { return }
            self.showTooltip()
        }
    }

    override func mouseExited(with event: NSEvent) {
        showTimer?.invalidate()
        showTimer = nil
        hideTooltip()
    }

    override func removeFromSuperview() {
        showTimer?.invalidate()
        stopObservingScroll()
        stopObservingAppDeactivation()
        hideTooltip()
        super.removeFromSuperview()
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if window != nil {
            startObservingScroll()
            startObservingAppDeactivation()
        } else {
            showTimer?.invalidate()
            stopObservingScroll()
            stopObservingAppDeactivation()
            hideTooltip()
        }
    }

    private func startObservingScroll() {
        guard scrollObserver == nil else { return }
        scrollObserver = NotificationCenter.default.addObserver(
            forName: NSScrollView.willStartLiveScrollNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Self.isScrolling = true
            self?.showTimer?.invalidate()
            self?.showTimer = nil
            self?.hideTooltip()
        }
        scrollEndObserver = NotificationCenter.default.addObserver(
            forName: NSScrollView.didEndLiveScrollNotification,
            object: nil,
            queue: .main
        ) { _ in
            // Brief delay so tracking-area recalculation settles before
            // we accept mouseEntered again.
            Task { @MainActor in
                try? await Task.sleep(nanoseconds: 300_000_000)
                guard !Task.isCancelled else { return }
                Self.isScrolling = false
            }
        }
    }

    private func stopObservingScroll() {
        if let observer = scrollObserver {
            NotificationCenter.default.removeObserver(observer)
            scrollObserver = nil
        }
        if let observer = scrollEndObserver {
            NotificationCenter.default.removeObserver(observer)
            scrollEndObserver = nil
        }
    }

    private func startObservingAppDeactivation() {
        guard appDeactivationObserver == nil else { return }
        appDeactivationObserver = NotificationCenter.default.addObserver(
            forName: NSApplication.didResignActiveNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.showTimer?.invalidate()
            self?.showTimer = nil
            self?.hideTooltip()
        }
    }

    private func stopObservingAppDeactivation() {
        if let observer = appDeactivationObserver {
            NotificationCenter.default.removeObserver(observer)
            appDeactivationObserver = nil
        }
    }

    /// Dismiss the tooltip and cancel any pending show timer.
    /// Called by `VTooltipCoordinator` when another tooltip activates.
    fileprivate func dismissTooltip() {
        showTimer?.invalidate()
        showTimer = nil
        hideTooltip()
    }

    /// Whether this view is actually visible and reachable by the user.
    ///
    /// `NSTrackingArea` fires `mouseEntered` even when the view is hidden
    /// behind another layer. SwiftUI's `.clipped()` uses CALayer masking
    /// which does NOT affect `NSView.visibleRect`, so we cannot rely on
    /// `visibleRect.isEmpty` alone. Instead, we walk the superview chain
    /// checking for concrete AppKit properties that SwiftUI DOES set on
    /// backing NSViews:
    ///
    /// - **`alphaValue < 0.01`** — catches SwiftUI's `.opacity(0)` which
    ///   is applied to the sidebar when the settings panel opens.
    /// - **`isHidden`** — catches any ancestor marked hidden.
    /// - **`frame.width < 1` or `frame.height < 1`** — catches SwiftUI's
    ///   `.frame(width: 0)` which shrinks the sidebar container to zero.
    ///
    /// Runs once per tooltip show attempt (after the 0.2 s delay fires),
    /// not per mouse-move. The walk is O(depth-of-view-tree), typically
    /// 20–50 views.
    private var isEffectivelyVisible: Bool {
        var current: NSView? = self
        while let view = current {
            if view.isHidden || view.alphaValue < 0.01 {
                return false
            }
            if view.frame.width < 1 || view.frame.height < 1 {
                return false
            }
            current = view.superview
        }
        return true
    }

    private func showTooltip() {
        guard panel == nil, let window else { return }

        // Dismiss any other active tooltip before creating ours.
        VTooltipCoordinator.shared.activate(self)

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

        let host = NSHostingView(rootView: VTooltipContent(text: tooltipText))
        host.frame.size = host.fittingSize
        p.contentView = host
        p.setContentSize(host.fittingSize)

        // Use AppKit's native coordinate conversion — works on any display
        let viewFrameInWindow = convert(bounds, to: nil)
        let anchorY = tooltipEdge == .bottom ? viewFrameInWindow.minY : viewFrameInWindow.maxY
        let screenPoint = window.convertPoint(toScreen: NSPoint(
            x: viewFrameInWindow.midX,
            y: anchorY
        ))

        let x = screenPoint.x - host.fittingSize.width / 2
        let y = tooltipEdge == .bottom ? screenPoint.y - host.fittingSize.height - 4 : screenPoint.y + 4
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

    private func hideTooltip() {
        guard let p = panel else { return }
        panel = nil
        // Detach from parent window before hiding.
        if let parentWindow = p.parent {
            parentWindow.removeChildWindow(p)
        }
        VTooltipCoordinator.shared.deactivate(self)
        NSAnimationContext.runAnimationGroup({ ctx in
            ctx.duration = 0.08
            p.animator().alphaValue = 0
        }, completionHandler: {
            p.orderOut(nil)
        })
    }
}

private struct VTooltipContent: View {
    let text: String

    var body: some View {
        Text(text)
            .fixedSize()
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
