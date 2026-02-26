import AVFoundation
import Foundation
import ScreenCaptureKit
import os

private let log = Logger(subsystem: "com.vellum.vellum-assistant", category: "SystemAudioCapture")

/// Captures system audio using ScreenCaptureKit's audio-only mode.
/// Delivers audio buffers via a callback for downstream processing
/// (e.g., speech recognition).
///
/// Uses SCStream configured with `capturesAudio = true` and video
/// dimensions set to minimum (1x1) since we only need audio.
/// Excludes the current process's audio to avoid feedback loops.
final class SystemAudioCapture: NSObject, @unchecked Sendable {

    /// Called on the output queue whenever a new audio sample buffer arrives.
    var onAudioBuffer: ((CMSampleBuffer) -> Void)?

    /// Called on the main queue when the stream stops unexpectedly.
    var onStreamError: ((Error) -> Void)?

    private(set) var isCapturing = false

    private var stream: SCStream?
    private let outputQueue = DispatchQueue(label: "com.vellum.SystemAudioCapture.output", qos: .userInteractive)

    // MARK: - Start / Stop

    /// Begin capturing system audio. Requires screen recording permission.
    func start() async throws {
        guard !isCapturing else { return }

        // Get shareable content to build a filter that captures all displays
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)

        guard let display = content.displays.first else {
            throw SystemAudioCaptureError.noDisplayAvailable
        }

        // Build a filter that captures the entire display but we only care about audio.
        // Exclude the current app so we don't capture our own TTS output.
        let selfBundleID = Bundle.main.bundleIdentifier ?? ""
        let excludedApps = content.applications.filter { $0.bundleIdentifier == selfBundleID }
        let filter = SCContentFilter(display: display, excludingApplications: excludedApps, exceptingWindows: [])

        let config = SCStreamConfiguration()
        // Minimal video config — we only want audio
        config.width = 2
        config.height = 2
        config.minimumFrameInterval = CMTime(value: 1, timescale: 1) // 1 fps minimum
        config.capturesAudio = true
        config.sampleRate = 48000
        config.channelCount = 1
        config.excludesCurrentProcessAudio = true

        let captureStream = SCStream(filter: filter, configuration: config, delegate: self)
        try captureStream.addStreamOutput(self, type: .audio, sampleHandlerQueue: outputQueue)

        try await captureStream.startCapture()
        self.stream = captureStream
        isCapturing = true

        log.info("System audio capture started (sampleRate=48000, mono, excludeSelf=true)")
    }

    /// Stop capturing system audio.
    func stop() {
        guard isCapturing, let stream else { return }
        isCapturing = false

        Task {
            do {
                try await stream.stopCapture()
                log.info("System audio capture stopped")
            } catch {
                log.error("Error stopping capture: \(error.localizedDescription, privacy: .public)")
            }
        }

        self.stream = nil
    }
}

// MARK: - SCStreamOutput + SCStreamDelegate

extension SystemAudioCapture: SCStreamOutput, SCStreamDelegate {

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio else { return }
        onAudioBuffer?(sampleBuffer)
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        let nsError = error as NSError
        log.error("SCStream stopped with error: \(nsError.domain, privacy: .public)/\(nsError.code) \(nsError.localizedDescription, privacy: .public)")
        isCapturing = false
        self.stream = nil

        DispatchQueue.main.async { [weak self] in
            self?.onStreamError?(error)
        }
    }
}

// MARK: - Errors

enum SystemAudioCaptureError: Error, LocalizedError {
    case noDisplayAvailable
    case permissionDenied

    var errorDescription: String? {
        switch self {
        case .noDisplayAvailable:
            return "No display available for audio capture"
        case .permissionDenied:
            return "Screen recording permission is required for system audio capture"
        }
    }
}
