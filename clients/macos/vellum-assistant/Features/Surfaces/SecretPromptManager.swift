import AppKit
import SwiftUI
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "SecretPromptManager")

/// Manages floating panels for daemon secret input requests.
///
/// When the daemon needs a secret value from the user (e.g. an API key),
/// it sends a `secret_request` message. This manager creates a floating NSPanel
/// with a SecureField and sends back a `secret_response`.
@MainActor
final class SecretPromptManager {

    private var panels: [String: NSPanel] = [:]
    private let panelWidth: CGFloat = 400

    /// Called when the user responds to a secret prompt.
    /// Parameters: (requestId, value?) — value is nil if user cancelled.
    /// Returns `true` if the IPC send succeeded.
    var onResponse: ((String, String?) -> Bool)?

    func showPrompt(_ message: SecretRequestMessage) {
        // Dismiss existing panel for same request, if any
        dismissPrompt(requestId: message.requestId)

        let view = SecretPromptView(
            label: message.label,
            description: message.description,
            placeholder: message.placeholder ?? "",
            onSave: { [weak self] value in
                self?.respond(requestId: message.requestId, value: value) ?? false
            },
            onCancel: { [weak self] in
                _ = self?.respond(requestId: message.requestId, value: nil)
            }
        )

        let hostingController = NSHostingController(rootView: view)
        hostingController.sizingOptions = .preferredContentSize

        let panelHeight: CGFloat = message.description != nil ? 270 : 230
        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: panelWidth, height: panelHeight),
            styleMask: [.titled, .nonactivatingPanel, .utilityWindow, .hudWindow],
            backing: .buffered,
            defer: false
        )

        panel.contentViewController = hostingController
        panel.level = .floating
        panel.isMovableByWindowBackground = true
        panel.titleVisibility = .hidden
        panel.titlebarAppearsTransparent = true
        panel.alphaValue = 0.95
        panel.isReleasedWhenClosed = false
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary]

        // Position at top-right of screen
        if let screen = NSScreen.main {
            let screenFrame = screen.visibleFrame
            let x = screenFrame.maxX - panelWidth - 20
            let y = screenFrame.maxY - panelHeight - 20
            panel.setFrameOrigin(NSPoint(x: x, y: y))
        }

        panels[message.requestId] = panel
        panel.orderFront(nil)

        log.info("Showing secret prompt: requestId=\(message.requestId), service=\(message.service), field=\(message.field)")
    }

    func dismissPrompt(requestId: String) {
        panels[requestId]?.close()
        panels.removeValue(forKey: requestId)
    }

    func dismissAll() {
        for (requestId, panel) in panels {
            panel.close()
            _ = onResponse?(requestId, nil)
        }
        panels.removeAll()
    }

    private func respond(requestId: String, value: String?) -> Bool {
        let success = onResponse?(requestId, value) ?? true
        if success && value == nil {
            // Cancel: dismiss immediately
            dismissPrompt(requestId: requestId)
        } else if success {
            // Save: delay dismiss so "Saved to Keychain" confirmation is visible
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
                self?.dismissPrompt(requestId: requestId)
            }
        }
        return success
    }
}

// MARK: - SecretPromptView

struct SecretPromptView: View {
    let label: String
    let description: String?
    let placeholder: String
    let onSave: (String) -> Bool
    let onCancel: () -> Void

    @State private var secretValue: String = ""
    @State private var saved = false

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            // Header
            HStack(spacing: VSpacing.md) {
                Image(systemName: "lock.shield.fill")
                    .font(.title2)
                    .foregroundStyle(VColor.accent)

                VStack(alignment: .leading, spacing: 2) {
                    Text("Secure Credential")
                        .font(VFont.headline)
                        .foregroundColor(VColor.textPrimary)
                    Text(label)
                        .font(VFont.caption)
                        .foregroundColor(VColor.textSecondary)
                }

                Spacer()
            }

            // Description
            if let description = description {
                Text(description)
                    .font(VFont.caption)
                    .foregroundColor(VColor.textSecondary)
            }

            // Secure input
            SecureField(placeholder, text: $secretValue)
                .textFieldStyle(.roundedBorder)
                .font(VFont.mono)

            // Safety explainer
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                safetyBullet(
                    icon: "key.fill",
                    text: "Stored in your Mac's Keychain, not sent to any server"
                )
                safetyBullet(
                    icon: "eye.slash.fill",
                    text: "The AI never sees this value — only your Mac can read it"
                )
            }

            if saved {
                HStack(spacing: VSpacing.xs) {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundColor(VColor.success)
                    Text("Saved to Keychain")
                        .font(VFont.caption)
                        .foregroundColor(VColor.success)
                }
            } else {
                // Buttons
                HStack(spacing: VSpacing.lg) {
                    Spacer()
                    VButton(label: "Cancel", style: .ghost) {
                        onCancel()
                    }
                    VButton(label: "Save", style: .primary) {
                        guard !secretValue.isEmpty else { return }
                        if onSave(secretValue) {
                            withAnimation(VAnimation.standard) { saved = true }
                        }
                    }
                    .disabled(secretValue.isEmpty)
                }
            }
        }
        .padding(VSpacing.xl)
        .frame(width: 400)
        .vPanelBackground()
    }

    private func safetyBullet(icon: String, text: String) -> some View {
        HStack(alignment: .top, spacing: VSpacing.sm) {
            Image(systemName: icon)
                .font(.system(size: 10))
                .foregroundColor(VColor.success)
                .frame(width: 14, alignment: .center)
            Text(text)
                .font(VFont.caption)
                .foregroundColor(VColor.textMuted)
        }
    }
}
