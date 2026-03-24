import AppKit
import SwiftUI
import os
import VellumAssistantShared

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
    /// Injected presenter so tests can suppress visible panel popups.
    /// Default behavior remains `orderFront(nil)` in app runtime.
    var panelPresenter: (NSPanel) -> Void = { panel in
        panel.orderFront(nil)
    }


    /// Called when the user responds to a secret prompt.
    /// Parameters: (requestId, value?, delivery?) — value is nil if user cancelled.
    /// `delivery` is "store" (default) or "transient_send" for one-time use.
    /// Returns `true` if the send succeeded.
    var onResponse: ((String, String?, String?) async -> Bool)?

    func showPrompt(_ message: SecretRequestMessage) {
        // Dismiss existing panel for same request, if any
        dismissPrompt(requestId: message.requestId)

        let view = SecretPromptView(
            label: message.label,
            description: message.description,
            placeholder: message.placeholder ?? "",
            purpose: message.purpose,
            allowedTools: message.allowedTools,
            allowedDomains: message.allowedDomains,
            allowOneTimeSend: message.allowOneTimeSend ?? false,
            onSave: { [weak self] value in
                await self?.respond(requestId: message.requestId, value: value, delivery: "store") ?? false
            },
            onSendOnce: { [weak self] value in
                await self?.respond(requestId: message.requestId, value: value, delivery: "transient_send") ?? false
            },
            onCancel: { [weak self] in
                _ = await self?.respond(requestId: message.requestId, value: nil)
            }
        )

        let hostingController = NSHostingController(rootView: view)
        hostingController.sizingOptions = .preferredContentSize

        let panel = KeyablePanel(
            contentRect: NSRect(x: 0, y: 0, width: panelWidth, height: 300),
            styleMask: [.borderless],
            backing: .buffered,
            defer: false
        )

        panel.contentViewController = hostingController

        // Re-measure now that the view is in the window hierarchy.
        // Use contentView.fittingSize (not the hosting controller's view directly)
        // so AppKit can resolve layout constraints against the panel.
        let panelHeight: CGFloat
        if let fittingSize = panel.contentView?.fittingSize {
            panelHeight = min(max(fittingSize.height, 230), 600)
        } else {
            panelHeight = 300
        }
        panel.setContentSize(NSSize(width: panelWidth, height: panelHeight))
        panel.level = .floating
        panel.isMovableByWindowBackground = true
        panel.backgroundColor = .clear
        panel.isOpaque = false
        panel.hasShadow = true

        panel.isReleasedWhenClosed = false
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary]
        panel.identifier = NSUserInterfaceItemIdentifier("SecureCredentialPanel")

        // Position at the top-right corner of the app window so the panel
        // stays near the content the user is working with, even when the
        // window is not full-screen. Falls back to screen top-right when
        // no app window is visible.
        let margin: CGFloat = 20
        let appWindow = NSApp.windows.first { $0 is TitleBarZoomableWindow && $0.isVisible }
        let screen = appWindow?.screen ?? NSScreen.main
        if let screenFrame = screen?.visibleFrame {
            let x: CGFloat
            let y: CGFloat
            if let anchor = appWindow {
                x = anchor.frame.maxX - panelWidth - margin
                y = anchor.frame.maxY - panelHeight - margin
            } else {
                x = screenFrame.maxX - panelWidth - margin
                y = screenFrame.maxY - panelHeight - margin
            }
            // Clamp within visible screen bounds so the panel never
            // goes off-screen on small windows or edge positions.
            let clampedX = max(screenFrame.minX + margin, min(x, screenFrame.maxX - panelWidth - margin))
            let clampedY = max(screenFrame.minY + margin, min(y, screenFrame.maxY - panelHeight - margin))
            panel.setFrameOrigin(NSPoint(x: clampedX, y: clampedY))
        }

        panels[message.requestId] = panel
        panelPresenter(panel)
        panel.makeKey()

        log.info("Showing secret prompt: requestId=\(message.requestId), service=\(message.service), field=\(message.field)")
    }

    /// Test-only accessor for the panel backing a given request.
    func panelForRequest(_ requestId: String) -> NSPanel? {
        panels[requestId]
    }

    func dismissPrompt(requestId: String) {
        panels[requestId]?.close()
        panels.removeValue(forKey: requestId)
    }

    func dismissAll() {
        let callback = onResponse
        for (requestId, panel) in panels {
            panel.close()
            Task { _ = await callback?(requestId, nil, nil) }
        }
        panels.removeAll()
    }

    /// Forward the user's response to the daemon via `onResponse`.
    ///
    /// **Security invariant**: This method intentionally never logs `value`.
    /// All logging in this class uses metadata-only fields (requestId, service, field).
    /// Any future change that adds logging here must be audited for secret leaks.
    private func respond(requestId: String, value: String?, delivery: String? = nil) async -> Bool {
        let success = await onResponse?(requestId, value, delivery) ?? true
        if success && value == nil {
            // Cancel: dismiss immediately
            dismissPrompt(requestId: requestId)
        } else if success {
            // Save: delay dismiss so "Saved" confirmation is visible
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
    let purpose: String?
    let allowedTools: [String]?
    let allowedDomains: [String]?
    let allowOneTimeSend: Bool
    let onSave: (String) async -> Bool
    let onSendOnce: (String) async -> Bool
    let onCancel: () async -> Void

    @State private var secretValue: String = ""
    @State private var saved = false
    @State private var isSending = false

    private var hasContext: Bool {
        purpose != nil
            || !(allowedTools ?? []).isEmpty
            || !(allowedDomains ?? []).isEmpty
    }

    var body: some View {
        ScrollView(.vertical, showsIndicators: false) {
            VStack(alignment: .leading, spacing: VSpacing.lg) {
                // Header
                HStack(spacing: VSpacing.md) {
                    VIconView(.shield, size: 20)
                        .foregroundStyle(VColor.primaryBase)

                    VStack(alignment: .leading, spacing: 2) {
                        Text("Secure Credential")
                            .font(VFont.bodySmallEmphasised)
                            .foregroundStyle(VColor.contentDefault)
                        Text(label)
                            .font(VFont.labelDefault)
                            .foregroundStyle(VColor.contentSecondary)
                    }
                    .textSelection(.enabled)

                    Spacer()
                }

                // Description
                if let description = description {
                    Text(description)
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.contentSecondary)
                        .textSelection(.enabled)
                }

                // Usage context
                if hasContext {
                    usageContextSection
                }

                // Secure input
                VTextField(
                    placeholder: placeholder,
                    text: $secretValue,
                    isSecure: true,
                    font: VFont.bodyMediumDefault
                )
                .accessibilityIdentifier("secure-credential-input")

                // Safety explainer
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    safetyBullet(
                        icon: "key.fill",
                        text: "Stored securely on your Mac, not sent to any server"
                    )
                    safetyBullet(
                        icon: "eye.slash.fill",
                        text: "The AI never sees this value — only your Mac can read it"
                    )
                }
                .textSelection(.enabled)

                if saved {
                    HStack(spacing: VSpacing.xs) {
                        VIconView(.circleCheck, size: 14)
                            .foregroundStyle(VColor.systemPositiveStrong)
                        Text("Saved securely")
                            .font(VFont.labelDefault)
                            .foregroundStyle(VColor.systemPositiveStrong)
                            .textSelection(.enabled)
                    }
                } else {
                    // Buttons
                    HStack(spacing: VSpacing.lg) {
                        Spacer()
                        VButton(label: "Cancel", style: .outlined, accessibilityID: "secure-credential-cancel") {
                            Task { await onCancel() }
                        }
                        .disabled(isSending)
                        .accessibilityLabel("Cancel")
                        VButton(label: isSending ? "Saving..." : "Save", style: .primary, accessibilityID: "secure-credential-save") {
                            let trimmed = secretValue.trimmingCharacters(in: .whitespacesAndNewlines)
                            guard !trimmed.isEmpty else { return }
                            isSending = true
                            Task {
                                let success = await onSave(trimmed)
                                isSending = false
                                if success {
                                    withAnimation(VAnimation.standard) { saved = true }
                                }
                            }
                        }
                        .disabled(isSending || secretValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        .accessibilityLabel("Save")
                    }

                    if allowOneTimeSend {
                        HStack(spacing: VSpacing.xs) {
                            VIconView(.triangleAlert, size: 10)
                                .foregroundStyle(VColor.systemNegativeHover)
                            VButton(label: isSending ? "Sending..." : "Send Once (not saved)", style: .outlined) {
                                let trimmed = secretValue.trimmingCharacters(in: .whitespacesAndNewlines)
                                guard !trimmed.isEmpty else { return }
                                isSending = true
                                Task {
                                    let success = await onSendOnce(trimmed)
                                    isSending = false
                                    if success {
                                        withAnimation(VAnimation.standard) { saved = true }
                                    }
                                }
                            }
                            .disabled(isSending || secretValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        }
                    }
                }
            }
            .padding(VSpacing.xl)
        }
        // fixedSize lets the ScrollView report its content's intrinsic height
        // for fittingSize measurement, while maxHeight caps it to prevent
        // unbounded growth (scroll kicks in when content exceeds 600pt).
        .fixedSize(horizontal: false, vertical: true)
        .frame(width: 400)
        .frame(maxHeight: 600)
        .vPanelBackground()
        .clipShape(RoundedRectangle(cornerRadius: VRadius.window))
    }

    @ViewBuilder
    private var usageContextSection: some View {
        VStack(alignment: .leading, spacing: VSpacing.xs) {
            Text("Usage Scope")
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentSecondary)

            if let purpose = purpose {
                contextBullet(icon: "info.circle.fill", label: "Purpose", value: purpose)
            }

            if let tools = allowedTools, !tools.isEmpty {
                contextBullet(icon: "wrench.fill", label: "Tools", value: tools.joined(separator: ", "))
            }

            if let domains = allowedDomains, !domains.isEmpty {
                contextBullet(icon: "globe", label: "Domains", value: domains.joined(separator: ", "))
            }
        }
        .padding(VSpacing.sm)
        .background(VColor.surfaceOverlay)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
        .textSelection(.enabled)
    }

    private func contextBullet(icon: String, label: String, value: String) -> some View {
        HStack(alignment: .top, spacing: VSpacing.sm) {
            VIconView(SFSymbolMapping.icon(forSFSymbol: icon, fallback: .puzzle), size: 10)
                .foregroundStyle(VColor.primaryBase)
                .frame(width: 14, alignment: .center)
            Text("\(label): \(value)")
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentTertiary)
        }
    }

    private func safetyBullet(icon: String, text: String) -> some View {
        HStack(alignment: .top, spacing: VSpacing.sm) {
            VIconView(SFSymbolMapping.icon(forSFSymbol: icon, fallback: .puzzle), size: 10)
                .foregroundStyle(VColor.systemPositiveStrong)
                .frame(width: 14, alignment: .center)
            Text(text)
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentTertiary)
        }
    }
}

// MARK: - KeyablePanel

/// Borderless NSPanel subclass that accepts key window status,
/// allowing SecureField (and other text inputs) to receive keyboard focus.
private final class KeyablePanel: NSPanel {
    override var canBecomeKey: Bool { true }
}
