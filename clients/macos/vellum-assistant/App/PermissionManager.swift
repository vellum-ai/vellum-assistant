import ApplicationServices
import AppKit

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

    static func requestScreenRecordingAccess() {
        // CGRequestScreenCaptureAccess() only shows the OS prompt once per app
        // install. On subsequent calls it's a no-op. Fall back to opening
        // System Settings directly if permission is still denied after the call.
        CGRequestScreenCaptureAccess()
        if !CGPreflightScreenCaptureAccess() {
            openScreenRecordingSettings()
        }
    }

    static func openScreenRecordingSettings() {
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture") {
            NSWorkspace.shared.open(url)
        }
    }
}
