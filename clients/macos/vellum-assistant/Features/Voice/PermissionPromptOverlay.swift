import AppKit
import AVFoundation
import Speech
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
    func show(kind: DeniedPermission, onDismiss: @escaping () -> Void) {
        dismiss()

        let width: CGFloat = 320
        let height: CGFloat = 200

        let contentView = PermissionPromptView(
            deniedPermission: kind,
            onDismiss: { [weak self] in
                self?.dismiss()
                onDismiss()
            },
            onOpenSettings: { [weak self] in
                self?.dismiss()
                // Call requestAccess to ensure the app registers with TCC
                // so it actually appears in System Settings.
                switch kind {
                case .microphone:
                    AVCaptureDevice.requestAccess(for: .audio) { _ in }
                    PermissionManager.openMicrophoneSettings()
                case .speechRecognition:
                    SFSpeechRecognizer.requestAuthorization { _ in }
                    PermissionManager.openSpeechRecognitionSettings()
                case .both:
                    AVCaptureDevice.requestAccess(for: .audio) { _ in }
                    PermissionManager.openMicrophoneSettings()
                }
                onDismiss()
            }
        )

        let hostingView = NSHostingView(rootView: contentView)
        hostingView.frame = NSRect(x: 0, y: 0, width: width, height: height)

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
        newPanel.contentView = hostingView
        newPanel.isMovableByWindowBackground = false

        if let screen = NSScreen.main {
            let screenFrame = screen.visibleFrame
            let x = screenFrame.midX - width / 2
            let y = screenFrame.maxY - 60 - height
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
}

/// SwiftUI content for the permission prompt, styled to match VModal.
private struct PermissionPromptView: View {
    let deniedPermission: PermissionPromptOverlay.DeniedPermission
    let onDismiss: () -> Void
    let onOpenSettings: () -> Void

    private var title: String {
        switch deniedPermission {
        case .microphone: "Microphone Access Required"
        case .speechRecognition: "Speech Recognition Required"
        case .both: "Permissions Required"
        }
    }

    private var body_: String {
        switch deniedPermission {
        case .microphone: "Dictation requires microphone access. Grant access in System Settings."
        case .speechRecognition: "Dictation requires speech recognition access. Grant access in System Settings."
        case .both: "Dictation requires microphone and speech recognition access. Grant access in System Settings."
        }
    }

    private var icon: VIcon {
        switch deniedPermission {
        case .microphone, .both: .micOff
        case .speechRecognition: .audioWaveform
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            VStack(spacing: VSpacing.sm) {
                VIconView(icon, size: 20)
                    .foregroundColor(VColor.systemNegativeStrong)

                Text(title)
                    .font(VFont.modalTitle)
                    .foregroundColor(VColor.contentDefault)

                Text(body_)
                    .font(VFont.body)
                    .foregroundColor(VColor.contentSecondary)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.horizontal, VSpacing.xl)
            .padding(.top, VSpacing.xl)
            .padding(.bottom, VSpacing.lg)

            HStack(spacing: VSpacing.sm) {
                VButton(label: "Dismiss", style: .outlined, size: .compact) {
                    onDismiss()
                }
                VButton(label: "Open System Settings", style: .primary, size: .compact) {
                    onOpenSettings()
                }
            }
            .padding(.horizontal, VSpacing.xl)
            .padding(.bottom, VSpacing.lg)
        }
        .background(VColor.surfaceOverlay)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.md)
                .stroke(VColor.borderBase, lineWidth: 1)
        )
    }
}
