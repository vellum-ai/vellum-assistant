import AppKit
import SwiftUI
import os
import VellumAssistantShared

private let log = Logger(subsystem: "com.vellum.vellum-assistant", category: "PermissionPrompt")

/// Overlay shown when microphone or speech recognition permissions have been denied,
/// directing the user to System Settings.
@MainActor
final class PermissionPromptOverlay {
    private var panel: NSPanel?

    /// Which permission(s) are currently denied.
    enum DeniedPermission {
        case microphone
        case speechRecognition
        case both
    }

    /// Show the denied-permission overlay centered on screen.
    func show(kind: DeniedPermission, keyName: String, onDismiss: @escaping () -> Void) {
        dismiss()

        let width: CGFloat = 360
        let height: CGFloat = 200

        let contentView = buildContentView(deniedPermission: kind, keyName: keyName, onDismiss: onDismiss)

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
        newPanel.appearance = NSAppearance(named: .darkAqua)

        if let screen = NSScreen.main {
            let screenFrame = screen.visibleFrame
            let x = screenFrame.midX - width / 2
            let y = screenFrame.midY - height / 2 + 100
            newPanel.setFrameOrigin(NSPoint(x: x, y: y))
        }

        self.panel = newPanel
        newPanel.orderFront(nil)

        log.info("Showing denied-permission overlay: \(String(describing: kind))")
    }

    func dismiss() {
        panel?.orderOut(nil)
        panel = nil
    }

    // MARK: - Content Building

    private func buildContentView(
        deniedPermission: DeniedPermission,
        keyName: String,
        onDismiss: @escaping () -> Void
    ) -> NSView {
        let container = PermissionOverlayBackground()
        container.wantsLayer = true

        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .centerX
        stack.spacing = VSpacing.md
        stack.translatesAutoresizingMaskIntoConstraints = false
        stack.edgeInsets = NSEdgeInsets(top: VSpacing.xl, left: VSpacing.xl, bottom: VSpacing.xl, right: VSpacing.xl)

        let title: String
        let body: String
        let openSettings: () -> Void
        let vicon: VIcon

        switch deniedPermission {
        case .microphone:
            title = "Microphone Access Required"
            body = "Dictation requires microphone access. Grant access in System Settings."
            vicon = .micOff
            openSettings = { PermissionManager.openMicrophoneSettings() }
        case .speechRecognition:
            title = "Speech Recognition Required"
            body = "Dictation requires speech recognition access. Grant access in System Settings."
            vicon = .audioWaveform
            openSettings = { PermissionManager.openSpeechRecognitionSettings() }
        case .both:
            title = "Permissions Required"
            body = "Dictation requires microphone and speech recognition access. Grant access in System Settings."
            vicon = .micOff
            openSettings = {
                NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy")!)
            }
        }

        // Icon
        let imageView = NSImageView()
        if let img = vicon.nsImage(size: 32) {
            imageView.image = img
            imageView.contentTintColor = NSColor(VColor.warning)
        }
        imageView.widthAnchor.constraint(equalToConstant: 32).isActive = true
        imageView.heightAnchor.constraint(equalToConstant: 32).isActive = true

        // Title
        let titleLabel = NSTextField(labelWithString: title)
        titleLabel.font = NSFont.systemFont(ofSize: 14, weight: .semibold)
        titleLabel.textColor = NSColor(VColor.textPrimary)
        titleLabel.alignment = .center

        // Body
        let bodyLabel = NSTextField(wrappingLabelWithString: body)
        bodyLabel.font = NSFont.systemFont(ofSize: 12)
        bodyLabel.textColor = NSColor(VColor.textSecondary)
        bodyLabel.alignment = .center
        bodyLabel.maximumNumberOfLines = 3
        bodyLabel.preferredMaxLayoutWidth = 300

        // Buttons
        let buttonStack = NSStackView()
        buttonStack.orientation = .horizontal
        buttonStack.spacing = VSpacing.sm

        let dismissButton = makeButton(title: "Dismiss", isPrimary: false) { [weak self] in
            self?.dismiss()
            onDismiss()
        }
        let settingsButton = makeButton(title: "Open System Settings", isPrimary: true) { [weak self] in
            self?.dismiss()
            openSettings()
            onDismiss()
        }

        buttonStack.addArrangedSubview(dismissButton)
        buttonStack.addArrangedSubview(settingsButton)

        stack.addArrangedSubview(imageView)
        stack.addArrangedSubview(titleLabel)
        stack.addArrangedSubview(bodyLabel)
        stack.addArrangedSubview(buttonStack)

        container.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: container.topAnchor),
            stack.bottomAnchor.constraint(equalTo: container.bottomAnchor),
            stack.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: container.trailingAnchor),
        ])

        return container
    }

    private func makeButton(title: String, isPrimary: Bool, action: @escaping () -> Void) -> NSButton {
        let button = OverlayActionButton(title: title, action: action)
        button.isBordered = false
        button.wantsLayer = true
        button.font = NSFont.systemFont(ofSize: 12, weight: .medium)

        if isPrimary {
            button.contentTintColor = .white
            button.layer?.backgroundColor = NSColor(VColor.accent).cgColor
            button.layer?.cornerRadius = VRadius.md
        } else {
            button.contentTintColor = NSColor(VColor.textSecondary)
            button.layer?.backgroundColor = NSColor(VColor.backgroundSubtle).cgColor
            button.layer?.cornerRadius = VRadius.md
        }

        let widthConstraint = button.widthAnchor.constraint(greaterThanOrEqualToConstant: 100)
        let heightConstraint = button.heightAnchor.constraint(equalToConstant: 30)
        NSLayoutConstraint.activate([widthConstraint, heightConstraint])

        return button
    }
}

/// NSButton subclass that invokes a closure on click without requiring target/action boilerplate.
private final class OverlayActionButton: NSButton {
    private var onClick: (() -> Void)?

    convenience init(title: String, action: @escaping () -> Void) {
        self.init(frame: .zero)
        self.title = title
        self.onClick = action
        self.target = self
        self.action = #selector(handleClick)
    }

    @objc private func handleClick() {
        onClick?()
    }
}

/// Rounded, semi-transparent background using design system tokens.
private class PermissionOverlayBackground: NSView {
    override var wantsUpdateLayer: Bool { true }

    override func updateLayer() {
        layer?.backgroundColor = NSColor(VColor.surface).withAlphaComponent(0.95).cgColor
        layer?.cornerRadius = VRadius.lg
        layer?.borderWidth = 1
        layer?.borderColor = NSColor(VColor.surfaceBorder).cgColor
    }
}
