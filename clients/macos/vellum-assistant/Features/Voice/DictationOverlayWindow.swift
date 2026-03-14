import AppKit
import SwiftUI
import os
import VellumAssistantShared

private let log = Logger(subsystem: "com.vellum.vellum-assistant", category: "DictationOverlay")

@MainActor
final class DictationOverlayWindow {
    private var panel: NSPanel?
    private var iconView: NSView?
    private var label: NSTextField?
    private var transcriptionLabel: NSTextField?
    private var spinner: NSProgressIndicator?
    private var currentState: DictationState?

    private static let baseHeight: CGFloat = 40
    private static let expandedHeight: CGFloat = 72
    private static let baseWidth: CGFloat = 160
    private static let maxTranscriptionWidth: CGFloat = 400

    private func panelWidth(for state: DictationState, hasTranscription: Bool = false) -> CGFloat {
        if hasTranscription { return Self.maxTranscriptionWidth }
        switch state {
        case .transforming: return 280
        default: return Self.baseWidth
        }
    }

    func show(state: DictationState) {
        currentState = state
        let width = panelWidth(for: state)
        let height = Self.baseHeight

        if let panel = panel {
            updateContent(state: state)
            // Clear transcription when state changes (new recording cycle)
            transcriptionLabel?.stringValue = ""

            if let screen = NSScreen.main {
                let screenFrame = screen.visibleFrame
                let x = screenFrame.midX - width / 2
                // Pin the top edge so the panel doesn't jump when contracting from expanded height
                let topY = panel.frame.origin.y + panel.frame.height
                let newFrame = NSRect(x: x, y: topY - height, width: width, height: height)
                panel.setFrame(newFrame, display: true, animate: false)
            }

            panel.orderFront(nil)
        } else {
            let contentView = buildContentView(state: state)

            let newPanel = NSPanel(
                contentRect: NSRect(x: 0, y: 0, width: width, height: height),
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

    /// Update the live transcription text shown below the status line.
    /// Only takes effect while the overlay is in the `.recording` state.
    func updatePartialTranscription(_ text: String) {
        guard case .recording = currentState else { return }
        guard let panel = panel else { return }

        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        transcriptionLabel?.stringValue = trimmed

        let hasText = !trimmed.isEmpty
        let width = hasText ? Self.maxTranscriptionWidth : Self.baseWidth
        let height = hasText ? Self.expandedHeight : Self.baseHeight
        transcriptionLabel?.isHidden = !hasText

        if let screen = NSScreen.main {
            let screenFrame = screen.visibleFrame
            let x = screenFrame.midX - width / 2
            // Keep the top edge pinned by computing y from the top
            let topY = panel.frame.origin.y + panel.frame.height
            let newFrame = NSRect(x: x, y: topY - height, width: width, height: height)
            panel.setFrame(newFrame, display: true, animate: false)
        }
    }

    func dismiss() {
        spinner?.stopAnimation(nil)
        panel?.orderOut(nil)
        panel = nil
        iconView = nil
        label = nil
        transcriptionLabel = nil
        spinner = nil
        currentState = nil
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
        let transcription = makeTranscriptionLabel()

        icon.translatesAutoresizingMaskIntoConstraints = false
        text.translatesAutoresizingMaskIntoConstraints = false
        transcription.translatesAutoresizingMaskIntoConstraints = false

        container.addSubview(icon)
        container.addSubview(text)
        container.addSubview(transcription)

        NSLayoutConstraint.activate([
            icon.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 16),
            icon.topAnchor.constraint(equalTo: container.topAnchor, constant: 12),

            text.leadingAnchor.constraint(equalTo: icon.trailingAnchor, constant: 8),
            text.trailingAnchor.constraint(lessThanOrEqualTo: container.trailingAnchor, constant: -16),
            text.centerYAnchor.constraint(equalTo: icon.centerYAnchor),

            transcription.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 16),
            transcription.trailingAnchor.constraint(lessThanOrEqualTo: container.trailingAnchor, constant: -16),
            transcription.topAnchor.constraint(equalTo: icon.bottomAnchor, constant: 4),
        ])

        self.iconView = icon
        self.label = text
        self.transcriptionLabel = transcription

        return container
    }

    private func updateContent(state: DictationState) {
        // Replace icon — stop old spinner before makeIcon overwrites self.spinner
        if let oldIcon = iconView, let container = oldIcon.superview {
            let oldSpinner = spinner
            let newIcon = makeIcon(for: state)
            newIcon.translatesAutoresizingMaskIntoConstraints = false
            container.addSubview(newIcon)
            NSLayoutConstraint.activate([
                newIcon.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 16),
                newIcon.topAnchor.constraint(equalTo: container.topAnchor, constant: 12),
            ])
            if let lbl = label {
                lbl.leadingAnchor.constraint(equalTo: newIcon.trailingAnchor, constant: 8).isActive = true
                lbl.centerYAnchor.constraint(equalTo: newIcon.centerYAnchor).isActive = true
            }
            if let transLbl = transcriptionLabel {
                transLbl.topAnchor.constraint(equalTo: newIcon.bottomAnchor, constant: 4).isActive = true
            }
            oldSpinner?.stopAnimation(nil)
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
            dot.layer?.backgroundColor = NSColor(VColor.systemNegativeStrong).cgColor
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
            return makeSymbolView(.wand, color: VColor.primaryBase)

        case .done:
            return makeSymbolView(.circleCheck, color: VColor.systemPositiveStrong)

        case .error:
            return makeSymbolView(.triangleAlert, color: VColor.systemNegativeStrong)
        }
    }

    private func makeSymbolView(_ icon: VIcon, color: Color) -> NSView {
        let imageView = NSImageView()
        if let img = icon.nsImage(size: 16) {
            imageView.image = img
            imageView.contentTintColor = NSColor(color)
        }
        imageView.widthAnchor.constraint(equalToConstant: 16).isActive = true
        imageView.heightAnchor.constraint(equalToConstant: 16).isActive = true
        return imageView
    }

    private func labelContent(for state: DictationState) -> (String, NSColor) {
        switch state {
        case .recording:
            return ("Recording...", NSColor(VColor.contentSecondary))
        case .processing:
            return ("Processing...", NSColor(VColor.contentSecondary))
        case .transforming(let instruction):
            let truncated = instruction.count > 30 ? String(instruction.prefix(30)) + "..." : instruction
            return ("Transforming: \(truncated)", NSColor(VColor.contentSecondary))
        case .done:
            return ("Done", NSColor(VColor.systemPositiveStrong))
        case .error(let message):
            return (message, NSColor(VColor.systemNegativeStrong))
        }
    }

    private func makeLabel(for state: DictationState) -> NSTextField {
        let (text, color) = labelContent(for: state)
        let field = NSTextField(labelWithString: text)
        field.font = NSFont(name: "Inter", size: 11) ?? NSFont.systemFont(ofSize: 11)
        field.textColor = color
        field.lineBreakMode = .byTruncatingTail
        field.maximumNumberOfLines = 1
        self.label = field
        return field
    }

    private func makeTranscriptionLabel() -> NSTextField {
        let field = NSTextField(labelWithString: "")
        field.font = NSFont(name: "Inter", size: 10) ?? NSFont.systemFont(ofSize: 10)
        field.textColor = NSColor(VColor.contentTertiary)
        field.lineBreakMode = .byWordWrapping
        field.maximumNumberOfLines = 2
        field.isHidden = true
        return field
    }
}

/// Rounded, semi-transparent background using design system tokens.
private class OverlayBackgroundView: NSView {
    override var wantsUpdateLayer: Bool { true }

    override func updateLayer() {
        layer?.backgroundColor = NSColor(VColor.surfaceBase).withAlphaComponent(0.95).cgColor
        layer?.cornerRadius = VRadius.lg
        layer?.borderWidth = 1
        layer?.borderColor = NSColor(VColor.borderBase).cgColor
    }
}
