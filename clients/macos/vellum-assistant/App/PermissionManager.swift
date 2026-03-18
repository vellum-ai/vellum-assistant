import ApplicationServices
import AppKit
import AVFoundation
import Speech
import UserNotifications

enum PermissionStatus {
    case granted
    case denied
    case unknown
}

enum PermissionManager {
    static func accessibilityStatus(prompt: Bool = false) -> PermissionStatus {
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue(): prompt] as CFDictionary
        let trusted = AXIsProcessTrustedWithOptions(options)
        return trusted ? .granted : .denied
    }

    static func screenRecordingStatus() -> PermissionStatus {
        return CGPreflightScreenCaptureAccess() ? .granted : .denied
    }

    static func microphoneStatus() -> PermissionStatus {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized:
            return .granted
        case .denied, .restricted:
            return .denied
        case .notDetermined:
            return .unknown
        @unknown default:
            return .unknown
        }
    }

    static func speechRecognitionStatus() -> PermissionStatus {
        switch SFSpeechRecognizer.authorizationStatus() {
        case .authorized:
            return .granted
        case .denied, .restricted:
            return .denied
        case .notDetermined:
            return .unknown
        @unknown default:
            return .unknown
        }
    }

    static func notificationStatus() async -> PermissionStatus {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        switch settings.authorizationStatus {
        case .authorized, .provisional, .ephemeral:
            return .granted
        case .denied:
            return .denied
        case .notDetermined:
            return .unknown
        @unknown default:
            return .unknown
        }
    }

    static func notificationBadgeStatus() async -> PermissionStatus {
        let settings = await UNUserNotificationCenter.current().notificationSettings()

        switch settings.authorizationStatus {
        case .authorized, .provisional, .ephemeral:
            switch settings.badgeSetting {
            case .enabled:
                return .granted
            case .disabled:
                return .denied
            case .notSupported:
                return .unknown
            @unknown default:
                return .unknown
            }
        case .denied:
            return .denied
        case .notDetermined:
            return .unknown
        @unknown default:
            return .unknown
        }
    }

    private static let hasRequestedScreenRecordingFlag = "hasRequestedScreenRecording"

    static func requestScreenRecordingAccess() {
        if CGPreflightScreenCaptureAccess() {
            openScreenRecordingSettings()
            return
        }

        let hasRequestedBefore = UserDefaults.standard.bool(forKey: hasRequestedScreenRecordingFlag)

        // CGRequestScreenCaptureAccess() only shows the native OS prompt on
        // its very first invocation per app install; subsequent calls are
        // no-ops. The API is non-blocking, so CGPreflightScreenCaptureAccess()
        // returns false immediately — before the user has a chance to respond
        // to the prompt. On the first call we therefore trust the native prompt
        // and skip the System Settings fallback to avoid showing both at once.
        CGRequestScreenCaptureAccess()

        if !hasRequestedBefore {
            UserDefaults.standard.set(true, forKey: hasRequestedScreenRecordingFlag)
        } else {
            openScreenRecordingSettings()
        }
    }

    static func requestMicrophoneAccess() {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized:
            openMicrophoneSettings()
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .audio) { _ in }
        case .denied, .restricted:
            openMicrophoneSettings()
        @unknown default:
            openMicrophoneSettings()
        }
    }

    static func requestSpeechRecognitionAccess() {
        switch SFSpeechRecognizer.authorizationStatus() {
        case .authorized:
            openSpeechRecognitionSettings()
        case .notDetermined:
            SFSpeechRecognizer.requestAuthorization { _ in }
        case .denied, .restricted:
            openSpeechRecognitionSettings()
        @unknown default:
            openSpeechRecognitionSettings()
        }
    }

    static func requestNotificationAccess() {
        Task { @MainActor in
            let settings = await UNUserNotificationCenter.current().notificationSettings()
            switch settings.authorizationStatus {
            case .notDetermined:
                _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])
            case .authorized, .provisional, .ephemeral:
                _ = openNotificationSettings()
            case .denied:
                _ = openNotificationSettings()
            @unknown default:
                _ = openNotificationSettings()
            }
        }
    }

    static func requestNotificationBadgeAccess() {
        Task { @MainActor in
            let settings = await UNUserNotificationCenter.current().notificationSettings()
            switch settings.authorizationStatus {
            case .notDetermined:
                _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])
            case .authorized, .provisional, .ephemeral:
                _ = openNotificationSettings()
            case .denied:
                _ = openNotificationSettings()
            @unknown default:
                _ = openNotificationSettings()
            }
        }
    }

    static func openAccessibilitySettings() {
        _ = openPrivacySettingsPane("Privacy_Accessibility")
    }

    static func openScreenRecordingSettings() {
        _ = openPrivacySettingsPane("Privacy_ScreenCapture")
    }

    static func openMicrophoneSettings() {
        _ = openPrivacySettingsPane("Privacy_Microphone")
    }

    static func openSpeechRecognitionSettings() {
        _ = openPrivacySettingsPane("Privacy_SpeechRecognition")
    }

    @discardableResult
    static func openNotificationSettings() -> Bool {
        let bundleIdentifier = Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant"
        let candidates = [
            "x-apple.systempreferences:com.apple.preference.notifications?id=\(bundleIdentifier)",
            "x-apple.systempreferences:com.apple.preference.notifications",
        ]

        for candidate in candidates {
            guard let url = URL(string: candidate) else { continue }
            if NSWorkspace.shared.open(url) {
                return true
            }
        }
        return false
    }

    @discardableResult
    private static func openPrivacySettingsPane(_ pane: String) -> Bool {
        guard let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?\(pane)") else {
            return false
        }
        return NSWorkspace.shared.open(url)
    }
}
