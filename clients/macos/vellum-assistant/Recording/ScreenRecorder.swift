import AVFoundation
import ScreenCaptureKit
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "ScreenRecorder")

/// Result of a completed recording.
struct RecordingResult: Sendable {
    let filePath: String
    let durationMs: Int
}

/// Errors that can occur during screen recording.
enum RecorderError: Error, LocalizedError {
    case noMatchingDisplay
    case noMatchingWindow
    case streamStartFailed(String)
    case writerSetupFailed(String)
    case notRecording
    case noFramesCaptured

    var errorDescription: String? {
        switch self {
        case .noMatchingDisplay: return "No matching display found for recording"
        case .noMatchingWindow: return "No matching window found for recording"
        case .streamStartFailed(let reason): return "Failed to start screen capture stream: \(reason)"
        case .writerSetupFailed(let reason): return "Failed to set up video writer: \(reason)"
        case .notRecording: return "No active recording to stop"
        case .noFramesCaptured: return "Recording produced no video frames"
        }
    }
}

/// App-agnostic screen recorder using ScreenCaptureKit + AVAssetWriter.
///
/// Records display or window content to .mov files with H.264 video and
/// optional AAC audio. Stores recordings in the app's Application Support
/// directory under `recordings/`.
@MainActor
final class ScreenRecorder: NSObject {

    private var stream: SCStream?
    private var assetWriter: AVAssetWriter?
    private var videoInput: AVAssetWriterInput?
    private var audioInput: AVAssetWriterInput?
    private var micInput: AVAssetWriterInput?
    private var startTime: CMTime?
    private var lastVideoTime: CMTime?
    private var recordingStartDate: Date?
    private var isRecordingActive = false
    private var hasReceivedVideoFrame = false

    /// Background queue for processing sample buffers from ScreenCaptureKit.
    private let outputQueue = DispatchQueue(label: "com.vellum.screen-recorder.output", qos: .userInitiated)

    /// The delegate object that receives sample buffers on the output queue.
    /// Stored to prevent premature deallocation.
    private var outputDelegate: StreamOutputDelegate?

    // MARK: - Recording Directory

    private static var recordingsDirectory: URL {
        let appSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        return appSupport.appendingPathComponent("vellum-assistant/recordings", isDirectory: true)
    }

    private static func ensureRecordingsDirectory() throws {
        try FileManager.default.createDirectory(at: recordingsDirectory, withIntermediateDirectories: true)
    }

    // MARK: - Start Recording

    /// Start recording the screen or a specific window.
    ///
    /// - Parameters:
    ///   - captureScope: Whether to capture a full display or a single window.
    ///   - displayId: CGDirectDisplayID as UInt32. Required when captureScope is `display`.
    ///   - windowId: CGWindowID. Required when captureScope is `window`.
    ///   - includeAudio: Whether to capture system audio (default: false).
    ///   - includeMicrophone: Whether to capture microphone audio (default: false). Requires macOS 14+.
    func start(
        captureScope: String = "display",
        displayId: String? = nil,
        windowId: Int? = nil,
        includeAudio: Bool = false,
        includeMicrophone: Bool = false
    ) async throws {
        guard !isRecordingActive else {
            log.warning("Already recording — ignoring start request")
            return
        }

        let shareable = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)

        let filter: SCContentFilter
        let captureWidth: Int
        let captureHeight: Int

        if captureScope == "window", let windowId {
            guard let window = shareable.windows.first(where: { Int($0.windowID) == windowId }) else {
                throw RecorderError.noMatchingWindow
            }
            filter = SCContentFilter(desktopIndependentWindow: window)
            captureWidth = Int(window.frame.width) * 2  // Retina
            captureHeight = Int(window.frame.height) * 2
        } else {
            // Display capture (default)
            let targetDisplay: SCDisplay
            if let displayId, let id = UInt32(displayId) {
                guard let display = shareable.displays.first(where: { $0.displayID == id }) else {
                    throw RecorderError.noMatchingDisplay
                }
                targetDisplay = display
            } else {
                guard let mainDisplay = shareable.displays.first else {
                    throw RecorderError.noMatchingDisplay
                }
                targetDisplay = mainDisplay
            }
            filter = SCContentFilter(display: targetDisplay, excludingApplications: [], exceptingWindows: [])
            captureWidth = Int(targetDisplay.width) * 2  // Retina
            captureHeight = Int(targetDisplay.height) * 2
        }

        // Configure stream
        let config = SCStreamConfiguration()
        config.width = captureWidth
        config.height = captureHeight
        config.minimumFrameInterval = CMTime(value: 1, timescale: 30) // 30 fps
        config.pixelFormat = kCVPixelFormatType_32BGRA
        config.showsCursor = true
        config.capturesAudio = includeAudio

        if includeAudio {
            config.sampleRate = 48000
            config.channelCount = 2
        }

        // SCStreamConfiguration.captureMicrophone and SCStreamOutputType.microphone
        // require macOS 15+ despite being declared in the macOS 14 SDK headers.
        if includeMicrophone, #available(macOS 15, *) {
            config.captureMicrophone = true
        }

        // Set up AVAssetWriter
        try Self.ensureRecordingsDirectory()
        let timestamp = ISO8601DateFormatter().string(from: Date()).replacingOccurrences(of: ":", with: "-")
        let outputURL = Self.recordingsDirectory.appendingPathComponent("recording-\(timestamp).mov")

        let writer: AVAssetWriter
        do {
            writer = try AVAssetWriter(outputURL: outputURL, fileType: .mov)
        } catch {
            throw RecorderError.writerSetupFailed(error.localizedDescription)
        }

        // Video input: H.264
        let videoSettings: [String: Any] = [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: captureWidth,
            AVVideoHeightKey: captureHeight,
        ]
        let vInput = AVAssetWriterInput(mediaType: .video, outputSettings: videoSettings)
        vInput.expectsMediaDataInRealTime = true
        writer.add(vInput)
        self.videoInput = vInput

        // Audio input: AAC (optional — system audio)
        if includeAudio {
            let audioSettings: [String: Any] = [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVSampleRateKey: 48000,
                AVNumberOfChannelsKey: 2,
                AVEncoderBitRateKey: 128000,
            ]
            let aInput = AVAssetWriterInput(mediaType: .audio, outputSettings: audioSettings)
            aInput.expectsMediaDataInRealTime = true
            writer.add(aInput)
            self.audioInput = aInput
        }

        // Microphone input: AAC (optional — separate track, macOS 14+)
        if includeMicrophone, #available(macOS 15, *) {
            let micSettings: [String: Any] = [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVSampleRateKey: 48000,
                AVNumberOfChannelsKey: 1,
                AVEncoderBitRateKey: 64000,
            ]
            let mInput = AVAssetWriterInput(mediaType: .audio, outputSettings: micSettings)
            mInput.expectsMediaDataInRealTime = true
            writer.add(mInput)
            self.micInput = mInput
        }

        self.assetWriter = writer

        // Create stream and output delegate
        let delegate = StreamOutputDelegate(recorder: self)
        self.outputDelegate = delegate

        let captureStream = SCStream(filter: filter, configuration: config, delegate: delegate)

        try captureStream.addStreamOutput(delegate, type: .screen, sampleHandlerQueue: outputQueue)
        if includeAudio {
            try captureStream.addStreamOutput(delegate, type: .audio, sampleHandlerQueue: outputQueue)
        }
        if includeMicrophone, #available(macOS 15, *) {
            try captureStream.addStreamOutput(delegate, type: .microphone, sampleHandlerQueue: outputQueue)
        }

        self.stream = captureStream

        // Start
        do {
            try await captureStream.startCapture()
        } catch {
            throw RecorderError.streamStartFailed(error.localizedDescription)
        }

        isRecordingActive = true
        hasReceivedVideoFrame = false
        recordingStartDate = Date()
        log.info("Screen recording started → \(outputURL.path, privacy: .public)")
    }

    // MARK: - Stop Recording

    /// Stop the active recording and return the result.
    ///
    /// - Returns: `RecordingResult` with the file path and duration.
    func stop() async throws -> RecordingResult {
        guard isRecordingActive else {
            throw RecorderError.notRecording
        }

        // Stop the capture stream
        if let stream {
            try? await stream.stopCapture()
        }
        stream = nil

        guard hasReceivedVideoFrame else {
            cleanUpWriter()
            throw RecorderError.noFramesCaptured
        }

        guard let writer = assetWriter else {
            throw RecorderError.notRecording
        }

        // Finish writing
        videoInput?.markAsFinished()
        audioInput?.markAsFinished()
        micInput?.markAsFinished()

        let outputURL = writer.outputURL

        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            writer.finishWriting {
                continuation.resume()
            }
        }

        let durationMs: Int
        if let startDate = recordingStartDate {
            durationMs = Int(Date().timeIntervalSince(startDate) * 1000)
        } else {
            durationMs = 0
        }

        cleanUpWriter()
        log.info("Screen recording stopped — duration=\(durationMs)ms, file=\(outputURL.path, privacy: .public)")

        return RecordingResult(filePath: outputURL.path, durationMs: durationMs)
    }

    // MARK: - Internal

    /// Process a sample buffer received from ScreenCaptureKit.
    /// Called from the output delegate on the background queue.
    nonisolated func handleSampleBuffer(_ sampleBuffer: CMSampleBuffer, ofType type: SCStreamOutputType) {
        let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        guard pts.isValid else { return }

        // Dispatch back to main actor for writer access
        Task { @MainActor in
            guard isRecordingActive else { return }
            guard let writer = assetWriter else { return }

            if writer.status == .unknown {
                writer.startWriting()
                writer.startSession(atSourceTime: pts)
                startTime = pts
            }

            guard writer.status == .writing else { return }

            switch type {
            case .screen:
                if let vInput = videoInput, vInput.isReadyForMoreMediaData {
                    vInput.append(sampleBuffer)
                    hasReceivedVideoFrame = true
                    lastVideoTime = pts
                }
            case .audio:
                if let aInput = audioInput, aInput.isReadyForMoreMediaData {
                    aInput.append(sampleBuffer)
                }
            case .microphone:
                if let mInput = micInput, mInput.isReadyForMoreMediaData {
                    mInput.append(sampleBuffer)
                }
            @unknown default:
                break
            }
        }
    }

    /// Cancel the active recording synchronously, discarding the output file.
    ///
    /// Uses `AVAssetWriter.cancelWriting()` which is synchronous and safe to
    /// call during `applicationWillTerminate` where async work cannot complete.
    func cancelRecording() {
        guard isRecordingActive else { return }

        // Stop the stream synchronously (best-effort — stopCapture is async but
        // we nil it out so no more buffers arrive).
        stream = nil

        assetWriter?.cancelWriting()

        // Remove the partial file to avoid leaving corrupted output
        if let outputURL = assetWriter?.outputURL {
            try? FileManager.default.removeItem(at: outputURL)
            log.info("Cancelled recording — removed partial file \(outputURL.path, privacy: .public)")
        }

        cleanUpWriter()
    }

    private func cleanUpWriter() {
        isRecordingActive = false
        assetWriter = nil
        videoInput = nil
        audioInput = nil
        micInput = nil
        startTime = nil
        lastVideoTime = nil
        recordingStartDate = nil
        outputDelegate = nil
    }
}

// MARK: - Stream Output Delegate

/// Receives sample buffers from SCStream on a background queue and forwards
/// them to the ScreenRecorder for writing.
private final class StreamOutputDelegate: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    private let recorder: ScreenRecorder

    init(recorder: ScreenRecorder) {
        self.recorder = recorder
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        recorder.handleSampleBuffer(sampleBuffer, ofType: type)
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        log.error("SCStream stopped with error: \(error.localizedDescription)")
    }
}
