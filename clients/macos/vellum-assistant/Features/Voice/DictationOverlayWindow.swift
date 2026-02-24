import AppKit
import os

private let log = Logger(subsystem: "com.vellum.vellum-assistant", category: "DictationOverlay")

@MainActor
final class DictationOverlayWindow {
    private var panel: NSPanel?
    private var iconView: NSView?
    private var label: NSTextField?
    private var spinner: NSProgressIndicator?

    private func panelWidth(for state: DictationState) -> CGFloat {
        switch state {
        case .transforming: return 280
        default: return 160
        }
    }

    func show(state: DictationState) {
        let width = panelWidth(for: state)

        if let panel = panel {
            updateContent(state: state)

            if let screen = NSScreen.main {
                let screenFrame = screen.visibleFrame
                let x = screenFrame.midX - width / 2
                let newFrame = NSRect(x: x, y: panel.frame.origin.y, width: width, height: 40)
                panel.setFrame(newFrame, display: true, animate: false)
            }

            panel.orderFront(nil)
        } else {
            let contentView = buildContentView(state: state)

            let newPanel = NSPanel(
                contentRect: NSRect(x: 0, y: 0, width: width, height: 40),
                styleMask: [.borderless, .nonactivatingPanel],
                backing: .buffered,
                defer: false
            )
            newPanel.isFloatingPanel = true
            newPanel.level = .floating
            newPanel.backgroundColor = .clear
            newPanel.isOpaque = false
            newPanel.hasShadow = true
            newPanel.contentView = contentView
            newPanel.isMovableByWindowBackground = false

            if let screen = NSScreen.main {
                let screenFrame = screen.visibleFrame
                let x = screenFrame.midX - width / 2
                let y = screenFrame.maxY - 60
                newPanel.setFrameOrigin(NSPoint(x: x, y: y))
            }

            self.panel = newPanel
            newPanel.orderFront(nil)
        }

        log.debug("Showing dictation overlay: \(String(describing: state))")
    }

    func dismiss() {
        spinner?.stopAnimation(nil)
        panel?.orderOut(nil)
        panel = nil
        iconView = nil
        label = nil
        spinner = nil
    }

    func showDoneAndDismiss() {
        show(state: .done)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { [weak self] in
            self?.dismiss()
        }
    }

    // MARK: - AppKit Content

    private func buildContentView(state: DictationState) -> NSView {
        let container = OverlayBackgroundView()
        container.wantsLayer = true

        let icon = makeIcon(for: state)
        let text = makeLabel(for: state)

        icon.translatesAutoresizingMaskIntoConstraints = false
        text.translatesAutoresizingMaskIntoConstraints = false

        container.addSubview(icon)
        container.addSubview(text)

        NSLayoutConstraint.activate([
            icon.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 16),
            icon.centerYAnchor.constraint(equalTo: container.centerYAnchor),

            text.leadingAnchor.constraint(equalTo: icon.trailingAnchor, constant: 8),
            text.trailingAnchor.constraint(lessThanOrEqualTo: container.trailingAnchor, constant: -16),
            text.centerYAnchor.constraint(equalTo: container.centerYAnchor),
        ])

        self.iconView = icon
        self.label = text

        return container
    }

    private func updateContent(state: DictationState) {
        // Replace icon
        if let oldIcon = iconView, let container = oldIcon.superview {
            let newIcon = makeIcon(for: state)
            newIcon.translatesAutoresizingMaskIntoConstraints = false
            container.addSubview(newIcon)
            NSLayoutConstraint.activate([
                newIcon.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 16),
                newIcon.centerYAnchor.constraint(equalTo: container.centerYAnchor),
            ])
            if let lbl = label {
                lbl.leadingAnchor.constraint(equalTo: newIcon.trailingAnchor, constant: 8).isActive = true
            }
            spinner?.stopAnimation(nil)
            oldIcon.removeFromSuperview()
            self.iconView = newIcon
        }

        // Update label
        let (text, color) = labelContent(for: state)
        label?.stringValue = text
        label?.textColor = color
    }

    private func makeIcon(for state: DictationState) -> NSView {
        switch state {
        case .recording:
            let dot = NSView(frame: NSRect(x: 0, y: 0, width: 8, height: 8))
            dot.wantsLayer = true
            dot.layer?.backgroundColor = NSColor.systemRed.cgColor
            dot.layer?.cornerRadius = 4
            dot.widthAnchor.constraint(equalToConstant: 8).isActive = true
            dot.heightAnchor.constraint(equalToConstant: 8).isActive = true
            return dot

        case .processing:
            let s = NSProgressIndicator()
            s.style = .spinning
            s.controlSize = .small
            s.isIndeterminate = true
            s.startAnimation(nil)
            s.widthAnchor.constraint(equalToConstant: 16).isActive = true
            s.heightAnchor.constraint(equalToConstant: 16).isActive = true
            self.spinner = s
            return s

        case .transforming:
            return makeSymbolView("wand.and.stars", color: .systemPurple)

        case .done:
            return makeSymbolView("checkmark.circle.fill", color: .systemGreen)

        case .error:
            return makeSymbolView("exclamationmark.triangle.fill", color: .systemRed)
        }
    }

    private func makeSymbolView(_ name: String, color: NSColor) -> NSView {
        let imageView = NSImageView()
        if let img = NSImage(systemSymbolName: name, accessibilityDescription: nil) {
            imageView.image = img
            imageView.contentTintColor = color
        }
        imageView.widthAnchor.constraint(equalToConstant: 16).isActive = true
        imageView.heightAnchor.constraint(equalToConstant: 16).isActive = true
        return imageView
    }

    private func labelContent(for state: DictationState) -> (String, NSColor) {
        switch state {
        case .recording:
            return ("Recording...", .secondaryLabelColor)
        case .processing:
            return ("Processing...", .secondaryLabelColor)
        case .transforming(let instruction):
            let truncated = instruction.count > 30 ? String(instruction.prefix(30)) + "..." : instruction
            return ("Transforming: \(truncated)", .secondaryLabelColor)
        case .done:
            return ("Done", .systemGreen)
        case .error(let message):
            return (message, .systemRed)
        }
    }

    private func makeLabel(for state: DictationState) -> NSTextField {
        let (text, color) = labelContent(for: state)
        let field = NSTextField(labelWithString: text)
        field.font = NSFont.systemFont(ofSize: 11)
        field.textColor = color
        field.lineBreakMode = .byTruncatingTail
        field.maximumNumberOfLines = 1
        self.label = field
        return field
    }
}

/// Rounded, semi-transparent background matching the app's dark surface style.
private class OverlayBackgroundView: NSView {
    override var wantsUpdateLayer: Bool { true }

    override func updateLayer() {
        layer?.backgroundColor = NSColor(white: 0.15, alpha: 0.95).cgColor
        layer?.cornerRadius = 12
        layer?.borderWidth = 1
        layer?.borderColor = NSColor(white: 0.25, alpha: 1.0).cgColor
    }
}
