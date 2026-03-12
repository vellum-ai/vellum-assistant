import VellumAssistantShared
import Foundation
import Speech
import SwiftUI

@Observable
@MainActor
final class JITPermissionManager {
    // Track what's been requested/granted
    var microphoneRequested = false
    var accessibilityRequested = false
    var screenCaptureRequested = false

    // Whether JIT mode is active (true when first_meeting variant was used)
    var isActive = false

    // Currently showing permission sheet
    var activePermissionRequest: JITPermissionType? = nil

    enum JITPermissionType {
        case microphone    // ears
        case accessibility // arms
        case screenCapture // eyes

        var bodyPart: String {
            switch self {
            case .microphone: return "ears"
            case .accessibility: return "arms"
            case .screenCapture: return "eyes"
            }
        }

        var title: String {
            switch self {
            case .microphone: return "Turn on my ears?"
            case .accessibility: return "Use my hands?"
            case .screenCapture: return "Turn on my eyes?"
            }
        }

        var message: String {
            switch self {
            case .microphone: return "Want to try talking? I just need to turn my ears on."
            case .accessibility: return "I can do that for you \u{2014} just need to use my hands. That okay?"
            case .screenCapture: return "Mind if I watch? I just need to turn my eyes on for a few minutes."
            }
        }

        var explanation: String {
            switch self {
            case .microphone: return "This lets me hear you when you hold the activation key. Audio is processed on-device and never stored."
            case .accessibility: return "This lets me click, type, and interact with apps on your behalf."
            case .screenCapture: return "This lets me see your screen so I can understand what you're working on."
            }
        }

        var technicalDetails: String {
            switch self {
            case .microphone: return "Grants access to the system microphone via the Speech Recognition permission. Used only during voice input activation (Fn key hold). Audio is processed locally by Apple's Speech Framework and transcribed text is sent to Claude for processing."
            case .accessibility: return "Grants Accessibility API access (AXUIElement) allowing programmatic control of UI elements. Required for computer control features like clicking buttons, typing text, and navigating applications on your behalf. Access is limited to user-initiated tasks."
            case .screenCapture: return "Grants Screen Recording permission allowing the app to capture screenshots of your display. Used during computer control sessions to provide visual context to Claude. Captures are transient and used only for task execution."
            }
        }

        var icon: String {
            switch self {
            case .microphone: return "ear"
            case .accessibility: return "hand.raised"
            case .screenCapture: return "eye"
            }
        }
    }

    // Check if permission is needed and show JIT request if so
    func requestIfNeeded(_ type: JITPermissionType) -> Bool {
        guard isActive else { return true } // Not in JIT mode, skip

        if isAlwaysAllowed(type) {
            // User previously chose Always Allow — skip the dialog but still verify OS permission.
            // If the OS permission was later revoked, trigger the grant flow directly without showing the dialog.
            switch type {
            case .microphone:
                if SFSpeechRecognizer.authorizationStatus() == .authorized { return true }
            case .accessibility:
                if PermissionManager.accessibilityStatus(prompt: false) == .granted { return true }
            case .screenCapture:
                if CGPreflightScreenCaptureAccess() { return true }
            }
            // OS permission not granted — trigger OS prompt directly without showing JIT dialog
            activePermissionRequest = type
            grantActivePermission()
            return false
        }

        switch type {
        case .microphone:
            if SFSpeechRecognizer.authorizationStatus() == .authorized { return true }
            activePermissionRequest = .microphone
            return false
        case .accessibility:
            if PermissionManager.accessibilityStatus(prompt: false) == .granted { return true }
            activePermissionRequest = .accessibility
            return false
        case .screenCapture:
            if CGPreflightScreenCaptureAccess() { return true }
            activePermissionRequest = .screenCapture
            return false
        }
    }

    // Grant the currently active permission; pass always: true to skip this dialog in future sessions
    func grantActivePermission(always: Bool = false) {
        guard let type = activePermissionRequest else { return }
        if always { setAlwaysAllowed(type) }
        switch type {
        case .microphone:
            SFSpeechRecognizer.requestAuthorization { _ in }
            microphoneRequested = true
        case .accessibility:
            _ = PermissionManager.accessibilityStatus(prompt: true)
            accessibilityRequested = true
        case .screenCapture:
            CGRequestScreenCaptureAccess()
            screenCaptureRequested = true
        }
        activePermissionRequest = nil
    }

    func dismissActivePermission() {
        activePermissionRequest = nil
    }

    // MARK: - Always Allow persistence

    private func alwaysAllowKey(for type: JITPermissionType) -> String {
        switch type {
        case .microphone:   return "com.vellum.jit.alwaysAllow.microphone"
        case .accessibility: return "com.vellum.jit.alwaysAllow.accessibility"
        case .screenCapture: return "com.vellum.jit.alwaysAllow.screenCapture"
        }
    }

    private func isAlwaysAllowed(_ type: JITPermissionType) -> Bool {
        UserDefaults.standard.bool(forKey: alwaysAllowKey(for: type))
    }

    private func setAlwaysAllowed(_ type: JITPermissionType) {
        UserDefaults.standard.set(true, forKey: alwaysAllowKey(for: type))
    }
}

#if DEBUG
struct JITPermissionManager_Preview: PreviewProvider {
    static var previews: some View {
        JITPermissionManagerPreviewWrapper()
            .frame(width: 500, height: 300)
            .previewDisplayName("JITPermissionManager")
    }
}

private struct JITPermissionManagerPreviewWrapper: View {
    @State private var manager = JITPermissionManager()

    var body: some View {
        VStack(spacing: VSpacing.xl) {
            Text("JIT Permission Manager")
                .font(VFont.headline)
                .foregroundColor(VColor.contentDefault)

            Text("Active: \(manager.isActive ? "Yes" : "No")")
                .font(VFont.body)
                .foregroundColor(VColor.contentSecondary)

            HStack(spacing: VSpacing.md) {
                OnboardingButton(title: "Request Mic", style: .tertiary) {
                    manager.isActive = true
                    _ = manager.requestIfNeeded(.microphone)
                }
                OnboardingButton(title: "Request A11y", style: .tertiary) {
                    manager.isActive = true
                    _ = manager.requestIfNeeded(.accessibility)
                }
                OnboardingButton(title: "Request Screen", style: .tertiary) {
                    manager.isActive = true
                    _ = manager.requestIfNeeded(.screenCapture)
                }
            }

            if let request = manager.activePermissionRequest {
                Text("Active request: \(request.title)")
                    .font(VFont.caption)
                    .foregroundColor(VColor.systemPositiveStrong)
            }
        }
        .padding(VSpacing.xxl)
        .background(VColor.surfaceOverlay)
    }
}
#endif
