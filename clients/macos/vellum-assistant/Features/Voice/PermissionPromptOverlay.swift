import AppKit
import AVFoundation
import Speech
import SwiftUI
import os
import VellumAssistantShared

private let log = Logger(subsystem: "com.vellum.vellum-assistant", category: "PermissionPrompt")

/// Floating overlay for microphone / speech-recognition permission prompts.
/// Supports two scenarios:
///   - **First use**: explains *why* permission is needed before the native system dialog.
///   - **Denied**: directs the user to System Settings after a previous denial.
@MainActor
final class PermissionPromptOverlay {
    private var panel: NSPanel?

    enum Kind {
        /// Pre-permission primer shown before the native system dialog.
        case firstUse
        /// Post-denial prompt directing to System Settings.
        case denied(DeniedPermission)
    }

    enum DeniedPermission {
        case microphone
        case speechRecognition
        case both
    }

    /// Show the overlay. `onContinue` is called when the user taps the primary button.
    func show(kind: Kind, onDismiss: @escaping () -> Void, onContinue: @escaping () -> Void) {
        dismiss()

        let width: CGFloat = 320

        let contentView: AnyView
        switch kind {
        case .firstUse:
            contentView = AnyView(FirstUsePromptView(
                onDismiss: { [weak self] in
                    self?.dismiss()
                    onDismiss()
                },
                onContinue: { [weak self] in
                    self?.dismiss()
                    onContinue()
                }
            ))
        case .denied(let denied):
            contentView = AnyView(DeniedPromptView(
                deniedPermission: denied,
                onDismiss: { [weak self] in
                    self?.dismiss()
                    onDismiss()
                },
                onOpenSettings: { [weak self] in
                    self?.dismiss()
                    // Call requestAccess to ensure the app registers with TCC
                    // so it actually appears in System Settings.
                    switch denied {
                    case .microphone:
                        AVCaptureDevice.requestAccess(for: .audio) { _ in }
                        PermissionManager.openMicrophoneSettings()
                    case .speechRecognition:
                        SFSpeechRecognizer.requestAuthorization { _ in }
                        PermissionManager.openSpeechRecognitionSettings()
                    case .both:
                        AVCaptureDevice.requestAccess(for: .audio) { _ in }
                        SFSpeechRecognizer.requestAuthorization { _ in }
                        PermissionManager.openMicrophoneSettings()
                    }
                    onDismiss()
                }
            ))
        }

        let hostingView = NSHostingView(rootView: contentView)

        let newPanel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: width, height: 10),
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

        // Let SwiftUI size the panel, then position it.
        hostingView.setFrameSize(hostingView.fittingSize)
        let size = hostingView.fittingSize
        newPanel.setContentSize(size)

        // Center over the main app window, falling back to screen center.
        let appWindow = NSApp.windows.first { $0 is TitleBarZoomableWindow && $0.isVisible }
        if let anchor = appWindow {
            let f = anchor.frame
            newPanel.setFrameOrigin(NSPoint(x: f.midX - size.width / 2, y: f.midY - size.height / 2))
        } else if let screen = NSScreen.main {
            let screenFrame = screen.visibleFrame
            newPanel.setFrameOrigin(NSPoint(x: screenFrame.midX - size.width / 2, y: screenFrame.midY - size.height / 2))
        }

        self.panel = newPanel
        newPanel.orderFront(nil)

        log.info("Showing permission overlay: \(String(describing: kind))")
    }

    func dismiss() {
        panel?.orderOut(nil)
        panel = nil
    }
}

// MARK: - First-Use Primer

private struct FirstUsePromptView: View {
    let onDismiss: () -> Void
    let onContinue: () -> Void

    private var assistantName: String {
        AssistantDisplayName.resolve(IdentityInfo.load()?.name)
    }

    var body: some View {
        VStack(spacing: 0) {
            VStack(spacing: VSpacing.sm) {
                VIconView(.mic, size: 20)
                    .foregroundColor(VColor.primaryBase)

                Text("Enable Speech Recognition")
                    .font(VFont.modalTitle)
                    .foregroundColor(VColor.contentDefault)

                Text("So your words come out the way you meant them.")
                    .font(VFont.body)
                    .foregroundColor(VColor.contentSecondary)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.horizontal, VSpacing.xl)
            .padding(.top, VSpacing.xl)
            .padding(.bottom, VSpacing.lg)

            HStack(spacing: VSpacing.sm) {
                VButton(label: "Not Now", style: .outlined, size: .compact) {
                    onDismiss()
                }
                VButton(label: "Continue", style: .primary, size: .compact) {
                    onContinue()
                }
            }
            .padding(.horizontal, VSpacing.xl)
            .padding(.bottom, VSpacing.lg)
        }
        .frame(width: 320)
        .background(VColor.surfaceOverlay)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.md)
                .stroke(VColor.borderBase, lineWidth: 1)
        )
    }
}

// MARK: - Denied Prompt

private struct DeniedPromptView: View {
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

    private var subtitle: String {
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

                Text(subtitle)
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
        .frame(width: 320)
        .background(VColor.surfaceOverlay)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.md)
                .stroke(VColor.borderBase, lineWidth: 1)
        )
    }
}
