import Foundation
import AVFoundation
import Speech

public class PermissionManager {
    public static let shared = PermissionManager()

    private init() {}

    public enum Permission {
        case microphone
        case speechRecognition
    }

    public func status(for permission: Permission) -> PermissionStatus {
        switch permission {
        case .microphone:
            switch AVCaptureDevice.authorizationStatus(for: .audio) {
            case .authorized: return .granted
            case .denied, .restricted: return .denied
            case .notDetermined: return .notDetermined
            @unknown default: return .notDetermined
            }
        case .speechRecognition:
            switch SFSpeechRecognizer.authorizationStatus() {
            case .authorized: return .granted
            case .denied, .restricted: return .denied
            case .notDetermined: return .notDetermined
            @unknown default: return .notDetermined
            }
        }
    }

    public func request(_ permission: Permission) async -> Bool {
        switch permission {
        case .microphone:
            return await AVCaptureDevice.requestAccess(for: .audio)
        case .speechRecognition:
            return await withCheckedContinuation { continuation in
                SFSpeechRecognizer.requestAuthorization { status in
                    continuation.resume(returning: status == .authorized)
                }
            }
        }
    }
}

public enum PermissionStatus {
    case granted
    case denied
    case notDetermined
}
