import AppKit

/// Custom NSView that handles mouse drag selection and draws a semi-transparent
/// overlay with the selected region cut out. Used inside `ScreenSelectionWindow`.
final class ScreenSelectionView: NSView {

    var onSelectionComplete: ((NSRect) -> Void)?
    var onCancel: (() -> Void)?

    private var origin: NSPoint?
    private var selectionRect: NSRect?

    override var acceptsFirstResponder: Bool { true }

    // MARK: - Drawing

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)

        // Semi-transparent dark overlay covering the entire screen
        NSColor.black.withAlphaComponent(0.3).setFill() // color-literal-ok: AppKit drawing context
        bounds.fill()

        guard let rect = selectionRect, rect.width > 1, rect.height > 1 else { return }

        // Cut out the selected region to show the screen underneath
        NSColor.clear.setFill()
        rect.fill(using: .copy)

        // White dashed border around the selection
        let border = NSBezierPath(rect: rect)
        border.lineWidth = 2
        NSColor.white.setStroke() // color-literal-ok: AppKit drawing context
        border.setLineDash([6, 4], count: 2, phase: 0)
        border.stroke()
    }

    // MARK: - Cursor

    override func resetCursorRects() {
        addCursorRect(bounds, cursor: .crosshair)
    }

    // MARK: - Mouse Events

    override func mouseDown(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        origin = point
        selectionRect = NSRect(origin: point, size: .zero)
        needsDisplay = true
    }

    override func mouseDragged(with event: NSEvent) {
        guard let origin else { return }
        let current = convert(event.locationInWindow, from: nil)
        let x = min(origin.x, current.x)
        let y = min(origin.y, current.y)
        let w = abs(current.x - origin.x)
        let h = abs(current.y - origin.y)
        selectionRect = NSRect(x: x, y: y, width: w, height: h)
        needsDisplay = true
    }

    override func mouseUp(with event: NSEvent) {
        guard let rect = selectionRect, rect.width > 4, rect.height > 4 else {
            // Too small — treat as cancel
            onCancel?()
            return
        }
        onSelectionComplete?(rect)
    }

    // MARK: - Keyboard

    override func keyDown(with event: NSEvent) {
        if event.keyCode == 53 { // Escape
            onCancel?()
        }
    }
}
