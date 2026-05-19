@preconcurrency import AVFoundation
import Foundation

struct CameraSnapshot {
    let jpegBase64: String
    let width: Int
    let height: Int
}

enum CameraSnapshotError: LocalizedError {
    case permissionDenied
    case noCamera
    case cannotAddInput
    case cannotAddOutput
    case captureFailed(String)

    var errorDescription: String? {
        switch self {
        case .permissionDenied:
            return "Camera permission is required for a webcam snapshot."
        case .noCamera:
            return "No camera is available."
        case .cannotAddInput:
            return "Unable to attach the camera input."
        case .cannotAddOutput:
            return "Unable to attach the camera output."
        case .captureFailed(let message):
            return "Camera capture failed: \(message)"
        }
    }
}

final class CameraSnapshotProvider: NSObject, AVCapturePhotoCaptureDelegate, @unchecked Sendable {
    private var continuation: CheckedContinuation<CameraSnapshot, Error>?
    private var session: AVCaptureSession?

    func captureOnce() async throws -> CameraSnapshot {
        let granted = try await ensureCameraAccess()
        guard granted else { throw CameraSnapshotError.permissionDenied }

        let session = AVCaptureSession()
        session.sessionPreset = .photo

        guard let device = AVCaptureDevice.default(for: .video) else {
            throw CameraSnapshotError.noCamera
        }
        let input = try AVCaptureDeviceInput(device: device)
        guard session.canAddInput(input) else {
            throw CameraSnapshotError.cannotAddInput
        }
        session.addInput(input)

        let output = AVCapturePhotoOutput()
        guard session.canAddOutput(output) else {
            throw CameraSnapshotError.cannotAddOutput
        }
        session.addOutput(output)

        self.session = session
        return try await withCheckedThrowingContinuation { continuation in
            self.continuation = continuation
            DispatchQueue.global(qos: .userInitiated).async {
                session.startRunning()
                let settings: AVCapturePhotoSettings
                if output.availablePhotoCodecTypes.contains(.jpeg) {
                    settings = AVCapturePhotoSettings(format: [AVVideoCodecKey: AVVideoCodecType.jpeg])
                } else {
                    settings = AVCapturePhotoSettings()
                }
                output.capturePhoto(with: settings, delegate: self)
            }
        }
    }

    func photoOutput(
        _ output: AVCapturePhotoOutput,
        didFinishProcessingPhoto photo: AVCapturePhoto,
        error: Error?
    ) {
        defer {
            session?.stopRunning()
            session = nil
            continuation = nil
        }

        if let error {
            continuation?.resume(throwing: CameraSnapshotError.captureFailed(error.localizedDescription))
            return
        }
        guard let data = photo.fileDataRepresentation() else {
            continuation?.resume(throwing: CameraSnapshotError.captureFailed("No image data returned."))
            return
        }

        let dimensions = photo.resolvedSettings.photoDimensions
        continuation?.resume(
            returning: CameraSnapshot(
                jpegBase64: data.base64EncodedString(),
                width: Int(dimensions.width),
                height: Int(dimensions.height)
            )
        )
    }

    private func ensureCameraAccess() async throws -> Bool {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            return true
        case .notDetermined:
            return await AVCaptureDevice.requestAccess(for: .video)
        case .denied, .restricted:
            return false
        @unknown default:
            return false
        }
    }
}
