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

    private static let hasRequestedScreenRecordingFlag = "hasRequestedScreenRecording"

    static func requestScreenRecordingAccess() {
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
        } else if !CGPreflightScreenCaptureAccess() {
            openScreenRecordingSettings()
        }
    }

    static func openScreenRecordingSettings() {
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture") {
            NSWorkspace.shared.open(url)
        }
    }
}
