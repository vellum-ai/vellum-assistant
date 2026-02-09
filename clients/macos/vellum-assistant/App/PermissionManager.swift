import ApplicationServices
import ScreenCaptureKit

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

    static func screenRecordingStatus() async -> PermissionStatus {
        do {
            _ = try await SCShareableContent.current
            return .granted
        } catch {
            return .denied
        }
    }
}
