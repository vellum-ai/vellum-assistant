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
    func vNativeTooltip(_ text: String) -> some View {
        self.background(NativeTooltipView(text: text))
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
    func vTooltip(_ text: String, delay: TimeInterval = 0.2) -> some View {
        self.overlay(
            VTooltipTracker(text: text, delay: delay)
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
    let delay: TimeInterval

    func makeNSView(context: Context) -> VTooltipTrackerView {
        let view = VTooltipTrackerView()
        view.tooltipText = text
        view.showDelay = delay
        return view
    }

    func updateNSView(_ nsView: VTooltipTrackerView, context: Context) {
        nsView.tooltipText = text
        nsView.showDelay = delay
    }
}

/// Invisible NSView that tracks mouse hover and shows a tooltip panel.
/// Returns `nil` from `hitTest` so all mouse events pass through to the
/// view underneath. The tooltip panel uses `ignoresMouseEvents = true`
/// so it never interferes with interaction.
private final class VTooltipTrackerView: NSView {
    var tooltipText: String = ""
    var showDelay: TimeInterval = 0.2
    private var showTimer: Timer?
    private var panel: NSPanel?

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
        showTimer?.invalidate()
        showTimer = Timer.scheduledTimer(withTimeInterval: showDelay, repeats: false) { [weak self] _ in
            self?.showTooltip()
        }
    }

    override func mouseExited(with event: NSEvent) {
        showTimer?.invalidate()
        showTimer = nil
        hideTooltip()
    }

    override func removeFromSuperview() {
        showTimer?.invalidate()
        hideTooltip()
        super.removeFromSuperview()
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if window == nil {
            showTimer?.invalidate()
            hideTooltip()
        }
    }

    private func showTooltip() {
        guard panel == nil, let window else { return }

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
        let screenPoint = window.convertPoint(toScreen: NSPoint(
            x: viewFrameInWindow.midX,
            y: viewFrameInWindow.maxY
        ))

        let x = screenPoint.x - host.fittingSize.width / 2
        let y = screenPoint.y + 4
        p.setFrameOrigin(NSPoint(x: x, y: y))

        p.alphaValue = 0
        p.orderFront(nil)
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = 0.12
            p.animator().alphaValue = 1
        }
        panel = p
    }

    private func hideTooltip() {
        guard let p = panel else { return }
        panel = nil
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
            .font(VFont.caption)
            .foregroundColor(VColor.contentDefault)
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
    func vNativeTooltip(_ text: String) -> some View {
        self.help(text)
    }

    /// On non-macOS platforms, falls back to the standard `.help()` modifier.
    func vTooltip(_ text: String, delay: TimeInterval = 0.2) -> some View {
        self.help(text)
    }
}
#endif
