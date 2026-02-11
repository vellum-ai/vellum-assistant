import ApplicationServices

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
        CGRequestScreenCaptureAccess()
    }
}
