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
        let preflightBeforeRequest = CGPreflightScreenCaptureAccess()

        // CGRequestScreenCaptureAccess() only shows the native OS prompt on
        // its very first invocation per app install; subsequent calls are
        // no-ops. The API is non-blocking, so CGPreflightScreenCaptureAccess()
        // returns false immediately — before the user has a chance to respond
        // to the prompt.
        CGRequestScreenCaptureAccess()

        if !hasRequestedBefore {
            UserDefaults.standard.set(true, forKey: hasRequestedScreenRecordingFlag)
            // On first request we cannot distinguish between a fresh install
            // (where the native prompt just appeared) and a legacy denied
            // install (where CGRequestScreenCaptureAccess() was a no-op).
            // In both cases CGPreflightScreenCaptureAccess() returns false.
            // To avoid opening System Settings alongside the native prompt
            // (double-prompt), we only open Settings when we know the user
            // had already been prompted before — i.e. hasRequestedBefore was
            // true. Legacy denied users will get the Settings fallback on
            // their next interaction.
        } else if !preflightBeforeRequest {
            // Permission was already denied before this request — the native
            // prompt won't appear, so open System Settings as a fallback.
            openScreenRecordingSettings()
        }
    }

    static func openScreenRecordingSettings() {
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture") {
            NSWorkspace.shared.open(url)
        }
    }
}
