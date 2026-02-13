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

    // Grant the currently active permission
    func grantActivePermission() {
        guard let type = activePermissionRequest else { return }
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
}

#Preview {
    @Previewable @State var manager = JITPermissionManager()

    VStack(spacing: VSpacing.xl) {
        Text("JIT Permission Manager")
            .font(VFont.headline)
            .foregroundColor(VColor.textPrimary)

        Text("Active: \(manager.isActive ? "Yes" : "No")")
            .font(VFont.body)
            .foregroundColor(VColor.textSecondary)

        HStack(spacing: VSpacing.md) {
            OnboardingButton(title: "Request Mic", style: .ghost) {
                manager.isActive = true
                _ = manager.requestIfNeeded(.microphone)
            }
            OnboardingButton(title: "Request A11y", style: .ghost) {
                manager.isActive = true
                _ = manager.requestIfNeeded(.accessibility)
            }
            OnboardingButton(title: "Request Screen", style: .ghost) {
                manager.isActive = true
                _ = manager.requestIfNeeded(.screenCapture)
            }
        }

        if let request = manager.activePermissionRequest {
            Text("Active request: \(request.title)")
                .font(VFont.caption)
                .foregroundColor(VColor.success)
        }
    }
    .padding(VSpacing.xxl)
    .frame(width: 500, height: 300)
    .background(VColor.background)
}
