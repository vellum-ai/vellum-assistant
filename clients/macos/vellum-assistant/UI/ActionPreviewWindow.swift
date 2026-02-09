import AppKit

/// A small, transparent window that briefly highlights where the agent will click.
final class ActionPreviewWindow {
    private var window: NSWindow?

    /// Show a colored dot at the given screen position, then fade it out.
    func flash(at point: CGPoint, color: NSColor = .systemBlue, duration: TimeInterval = 0.3) {
        let size: CGFloat = 24
        let frame = NSRect(
            x: point.x - size / 2,
            y: NSScreen.main!.frame.height - point.y - size / 2, // Flip to screen coords
            width: size,
            height: size
        )

        let w = NSWindow(contentRect: frame, styleMask: .borderless, backing: .buffered, defer: false)
        w.isOpaque = false
        w.backgroundColor = .clear
        w.level = .screenSaver
        w.ignoresMouseEvents = true
        w.hasShadow = false

        let dot = NSView(frame: NSRect(origin: .zero, size: CGSize(width: size, height: size)))
        dot.wantsLayer = true
        dot.layer?.cornerRadius = size / 2
        dot.layer?.backgroundColor = color.withAlphaComponent(0.6).cgColor
        dot.layer?.borderWidth = 2
        dot.layer?.borderColor = color.cgColor
        w.contentView = dot

        w.orderFrontRegardless()
        self.window = w

        // Animate fade-out, then remove
        NSAnimationContext.runAnimationGroup({ context in
            context.duration = duration
            w.animator().alphaValue = 0
        }, completionHandler: { [weak self] in
            w.orderOut(nil)
            self?.window = nil
        })
    }
}
