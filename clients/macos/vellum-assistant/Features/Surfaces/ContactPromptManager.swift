import AppKit
import SwiftUI
import os
import VellumAssistantShared

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "ContactPromptManager")

/// Manages floating panels for contact channel address requests.
///
/// When the assistant needs a new contact's address (e.g. a phone number or
/// email), it emits a `contact_request` message. This manager creates a
/// floating NSPanel with a text field and submits the result via
/// `sendContactPromptResponse`.
@MainActor
final class ContactPromptManager {

    private var panels: [String: NSPanel] = [:]
    private let panelWidth: CGFloat = 400

    /// Injected presenter so tests can suppress visible panel popups.
    var panelPresenter: (NSPanel) -> Void = { panel in
        panel.orderFront(nil)
    }

    /// Called when the user responds to a contact prompt.
    /// Parameters: (requestId, address?, channelType, role?) — address is nil if cancelled.
    /// Returns `true` if the send succeeded.
    var onResponse: ((String, String?, String, String?) async -> Bool)?

    func showPrompt(_ message: ContactRequestMessage) {
        dismissPrompt(requestId: message.requestId)

        let channelType = (message.channel ?? "email")
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
            .isEmpty ? "email" : (message.channel ?? "email")
                .trimmingCharacters(in: .whitespacesAndNewlines)
                .lowercased()

        let view = ContactPromptView(
            label: message.label ?? "Add Contact",
            description: message.description,
            placeholder: message.placeholder ?? "Enter \(channelType) address",
            channelType: channelType,
            role: message.role,
            onSave: { [weak self] address in
                await self?.respond(
                    requestId: message.requestId,
                    address: address,
                    channelType: channelType,
                    role: message.role
                ) ?? false
            },
            onCancel: { [weak self] in
                _ = await self?.respond(
                    requestId: message.requestId,
                    address: nil,
                    channelType: channelType,
                    role: message.role
                )
            }
        )

        let hostingController = NSHostingController(rootView: view)
        hostingController.sizingOptions = .preferredContentSize

        let panel = KeyableContactPanel(
            contentRect: NSRect(x: 0, y: 0, width: panelWidth, height: 280),
            styleMask: [.borderless],
            backing: .buffered,
            defer: false
        )

        panel.contentViewController = hostingController

        let panelHeight: CGFloat
        if let fittingSize = panel.contentView?.fittingSize {
            panelHeight = min(max(fittingSize.height, 220), 500)
        } else {
            panelHeight = 280
        }
        panel.setContentSize(NSSize(width: panelWidth, height: panelHeight))
        panel.level = .floating
        panel.isMovableByWindowBackground = true
        panel.backgroundColor = .clear
        panel.isOpaque = false
        panel.hasShadow = true
        panel.isReleasedWhenClosed = false
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary]
        panel.identifier = NSUserInterfaceItemIdentifier("ContactPromptPanel")

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
            let clampedX = max(screenFrame.minX + margin, min(x, screenFrame.maxX - panelWidth - margin))
            let clampedY = max(screenFrame.minY + margin, min(y, screenFrame.maxY - panelHeight - margin))
            panel.setFrameOrigin(NSPoint(x: clampedX, y: clampedY))
        }

        panels[message.requestId] = panel
        panelPresenter(panel)
        panel.makeKey()

        log.info("Showing contact prompt: requestId=\(message.requestId, privacy: .public) channelType=\(channelType, privacy: .public)")
    }

    func panelForRequest(_ requestId: String) -> NSPanel? {
        panels[requestId]
    }

    func dismissPrompt(requestId: String) {
        panels[requestId]?.close()
        panels.removeValue(forKey: requestId)
    }

    func dismissAll() {
        for (_, panel) in panels { panel.close() }
        panels.removeAll()
    }

    private func respond(requestId: String, address: String?, channelType: String, role: String?) async -> Bool {
        let success = await onResponse?(requestId, address, channelType, role) ?? true
        if address == nil {
            dismissPrompt(requestId: requestId)
        } else if success {
            Task { @MainActor [weak self] in
                try? await Task.sleep(nanoseconds: 1_500_000_000)
                self?.dismissPrompt(requestId: requestId)
            }
        }
        return success
    }
}

// MARK: - ContactPromptView

struct ContactPromptView: View {
    let label: String
    let description: String?
    let placeholder: String
    let channelType: String
    let role: String?
    let onSave: (String) async -> Bool
    let onCancel: () async -> Void

    @State private var addressValue: String = ""
    @State private var saved = false
    @State private var isSending = false

    private var canSave: Bool {
        !addressValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !isSending
    }

    var body: some View {
        ScrollView(.vertical, showsIndicators: false) {
            VStack(alignment: .leading, spacing: VSpacing.lg) {
                // Header
                HStack(spacing: VSpacing.md) {
                    VIconView(.contact, size: 20)
                        .foregroundStyle(VColor.primaryBase)

                    VStack(alignment: .leading, spacing: 2) {
                        Text("Add Contact")
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
                if let description {
                    Text(description)
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.contentSecondary)
                        .textSelection(.enabled)
                }

                // Address input
                VTextField(
                    placeholder: placeholder,
                    text: $addressValue,
                    isSecure: false,
                    font: VFont.bodyMediumDefault
                )
                .accessibilityIdentifier("contact-address-input")

                if saved {
                    HStack(spacing: VSpacing.xs) {
                        VIconView(.circleCheck, size: 14)
                            .foregroundStyle(VColor.systemPositiveStrong)
                        Text("Contact saved")
                            .font(VFont.labelDefault)
                            .foregroundStyle(VColor.systemPositiveStrong)
                            .textSelection(.enabled)
                    }
                } else {
                    HStack(spacing: VSpacing.lg) {
                        Spacer()
                        VButton(label: "Cancel", style: .outlined, accessibilityID: "contact-prompt-cancel") {
                            Task { await onCancel() }
                        }
                        .disabled(isSending)
                        VButton(
                            label: isSending ? "Saving..." : "Save",
                            style: .primary,
                            accessibilityID: "contact-prompt-save"
                        ) {
                            let trimmed = addressValue.trimmingCharacters(in: .whitespacesAndNewlines)
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
                        .disabled(!canSave)
                    }
                }
            }
            .padding(VSpacing.xl)
        }
        .fixedSize(horizontal: false, vertical: true)
        .frame(width: 400)
        .frame(maxHeight: 500)
        .vPanelBackground()
        .clipShape(RoundedRectangle(cornerRadius: VRadius.window))
    }
}

// MARK: - KeyableContactPanel

private final class KeyableContactPanel: NSPanel {
    override var canBecomeKey: Bool { true }
}
