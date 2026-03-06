import AppKit
import SwiftUI
import os
import VellumAssistantShared

private let log = Logger(subsystem: "com.vellum.vellum-assistant", category: "PermissionPrompt")

/// Lightweight overlay that explains why microphone/speech permissions are needed
/// and provides action buttons to grant access or open System Settings.
@MainActor
final class PermissionPromptOverlay {
    private var panel: NSPanel?

    /// Which permission(s) are currently denied, so the overlay can show the correct
    /// guidance and open the right System Settings pane.
    enum DeniedPermission {
        case microphone
        case speechRecognition
        case both
    }

    enum PromptKind {
        /// Permission has never been requested — show explanation and "Grant Access" button.
        case notDetermined(keyName: String)
        /// Permission was denied — show guidance to System Settings.
        case denied(keyName: String, deniedPermission: DeniedPermission)
    }

    /// Show the permission prompt overlay centered near the top of the screen.
    /// - Parameters:
    ///   - kind: Whether this is a first-ask or a denied state.
    ///   - onGrantAccess: Called when the user taps "Grant Access" (notDetermined only).
    ///   - onDismiss: Called when the user taps "Not Now" or the overlay is dismissed.
    func show(kind: PromptKind, onGrantAccess: @escaping () -> Void, onDismiss: @escaping () -> Void) {
        dismiss()

        let width: CGFloat = 360
        let height: CGFloat = 180

        let contentView = buildContentView(kind: kind, onGrantAccess: onGrantAccess, onDismiss: onDismiss)

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
            let y = screenFrame.midY - height / 2 + 100
            newPanel.setFrameOrigin(NSPoint(x: x, y: y))
        }

        self.panel = newPanel
        newPanel.orderFront(nil)

        log.info("Showing permission prompt overlay: \(String(describing: kind))")
    }

    func dismiss() {
        panel?.orderOut(nil)
        panel = nil
    }

    // MARK: - Content Building

    private func buildContentView(
        kind: PromptKind,
        onGrantAccess: @escaping () -> Void,
        onDismiss: @escaping () -> Void
    ) -> NSView {
        let container = PermissionOverlayBackground()
        container.wantsLayer = true

        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .centerX
        stack.spacing = 12
        stack.translatesAutoresizingMaskIntoConstraints = false
        stack.edgeInsets = NSEdgeInsets(top: 20, left: 24, bottom: 20, right: 24)

        let (title, body, primaryTitle, primaryAction, secondaryTitle, secondaryAction) = content(
            for: kind,
            onGrantAccess: onGrantAccess,
            onDismiss: onDismiss
        )

        // Icon
        let iconView = makeIconView(for: kind)

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
        buttonStack.spacing = 10

        let secondaryButton = makeButton(title: secondaryTitle, isPrimary: false, action: secondaryAction)
        let primaryButton = makeButton(title: primaryTitle, isPrimary: true, action: primaryAction)

        buttonStack.addArrangedSubview(secondaryButton)
        buttonStack.addArrangedSubview(primaryButton)

        stack.addArrangedSubview(iconView)
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

    private func content(
        for kind: PromptKind,
        onGrantAccess: @escaping () -> Void,
        onDismiss: @escaping () -> Void
    ) -> (title: String, body: String, primaryTitle: String, primaryAction: () -> Void, secondaryTitle: String, secondaryAction: () -> Void) {
        switch kind {
        case .notDetermined(let keyName):
            return (
                title: "Microphone Access Needed",
                body: "Hold \(keyName) to dictate text or start a voice conversation. Vellum uses on-device speech recognition — nothing you say leaves your Mac.",
                primaryTitle: "Grant Access",
                primaryAction: { [weak self] in
                    self?.dismiss()
                    onGrantAccess()
                },
                secondaryTitle: "Not Now",
                secondaryAction: { [weak self] in
                    self?.dismiss()
                    onDismiss()
                }
            )
        case .denied(let keyName, let deniedPermission):
            let title: String
            let body: String
            let openSettings: () -> Void

            switch deniedPermission {
            case .microphone:
                title = "Microphone Access Required"
                body = "Push-to-talk requires microphone access. You can grant access in System Settings. (Triggered by \(keyName) key)"
                openSettings = { PermissionManager.openMicrophoneSettings() }
            case .speechRecognition:
                title = "Speech Recognition Required"
                body = "Push-to-talk requires speech recognition access. You can grant access in System Settings. (Triggered by \(keyName) key)"
                openSettings = { PermissionManager.openSpeechRecognitionSettings() }
            case .both:
                title = "Permissions Required"
                body = "Push-to-talk requires microphone and speech recognition access. You can grant access in System Settings. (Triggered by \(keyName) key)"
                openSettings = {
                    NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy")!)
                }
            }

            return (
                title: title,
                body: body,
                primaryTitle: "Open System Settings",
                primaryAction: { [weak self] in
                    self?.dismiss()
                    openSettings()
                    onDismiss()
                },
                secondaryTitle: "Dismiss",
                secondaryAction: { [weak self] in
                    self?.dismiss()
                    onDismiss()
                }
            )
        }
    }

    private func makeIconView(for kind: PromptKind) -> NSView {
        let vicon: VIcon
        let color: NSColor

        switch kind {
        case .notDetermined:
            vicon = .mic
            color = .systemBlue
        case .denied(_, let deniedPermission):
            color = .systemOrange
            switch deniedPermission {
            case .microphone:
                vicon = .micOff
            case .speechRecognition:
                vicon = .audioWaveform
            case .both:
                vicon = .micOff
            }
        }

        let imageView = NSImageView()
        if let img = vicon.nsImage(size: 36) {
            imageView.image = img
            imageView.contentTintColor = color
        }
        imageView.widthAnchor.constraint(equalToConstant: 36).isActive = true
        imageView.heightAnchor.constraint(equalToConstant: 36).isActive = true
        return imageView
    }

    private func makeButton(title: String, isPrimary: Bool, action: @escaping () -> Void) -> NSButton {
        let button = OverlayActionButton(title: title, action: action)
        button.bezelStyle = .rounded
        button.font = NSFont.systemFont(ofSize: 12, weight: isPrimary ? .medium : .regular)

        if isPrimary {
            button.contentTintColor = .white
            button.wantsLayer = true
            button.layer?.backgroundColor = NSColor(VColor.accent).cgColor
            button.layer?.cornerRadius = VRadius.sm
        }

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
