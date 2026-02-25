import ScreenCaptureKit
import AVFoundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "ScreenRecorder")

/// App-agnostic screen recorder using ScreenCaptureKit.
/// Records display or window content to a video file via AVAssetWriter.
@MainActor
final class ScreenRecorder: NSObject {

    struct RecordingResult {
        let filePath: String
        let durationMs: Double
    }

    enum RecorderError: Error, LocalizedError {
        case noMatchingDisplay
        case noMatchingWindow
        case streamStartFailed(Error)
        case writerSetupFailed(String)
        case notRecording
        case noFramesCaptured

        var errorDescription: String? {
            switch self {
            case .noMatchingDisplay:
                return "No matching display found for the given displayId"
            case .noMatchingWindow:
                return "No matching window found for the given windowId"
            case .streamStartFailed(let underlying):
                return "Failed to start screen capture stream: \(underlying.localizedDescription)"
            case .writerSetupFailed(let reason):
                return "Failed to set up asset writer: \(reason)"
            case .notRecording:
                return "No active recording to stop"
            case .noFramesCaptured:
                return "Recording stopped before any video frames were captured"
            }
        }
    }

    // MARK: - State

    private(set) var isRecording = false
    private var stream: SCStream?
    private var streamOutput: RecorderStreamOutput?
    private var outputFileURL: URL?

    // MARK: - Public API

    /// Start recording with the given options.
    /// - Parameters:
    ///   - captureScope: "display" or "window" (defaults to "display")
    ///   - displayId: CGDirectDisplayID as string (uses main display if nil)
    ///   - windowId: CGWindowID (required when captureScope is "window")
    ///   - includeAudio: whether to capture system audio
    func start(
        captureScope: String?,
        displayId: String?,
        windowId: Double?,
        includeAudio: Bool
    ) async throws {
        guard !isRecording else {
            log.warning("start() called while already recording, ignoring")
            return
        }

        let scope = captureScope ?? "display"
        log.info("Starting recording — scope=\(scope), displayId=\(displayId ?? "nil"), windowId=\(windowId.map { String($0) } ?? "nil"), audio=\(includeAudio)")

        let content = try await SCShareableContent.current

        // Build content filter and determine capture dimensions
        let (filter, captureWidth, captureHeight) = try buildFilter(
            scope: scope,
            displayId: displayId,
            windowId: windowId,
            content: content
        )

        // Configure stream
        let config = SCStreamConfiguration()
        config.width = captureWidth
        config.height = captureHeight
        config.pixelFormat = kCVPixelFormatType_32BGRA
        config.showsCursor = true
        config.minimumFrameInterval = CMTime(value: 1, timescale: 30) // 30 fps

        if includeAudio {
            config.capturesAudio = true
            config.sampleRate = 48000
            config.channelCount = 2
        }

        // Prepare output file
        let fileURL = try prepareOutputFile()
        outputFileURL = fileURL

        // Set up AVAssetWriter
        let (writer, videoInput, audioInput) = try setupAssetWriter(
            outputURL: fileURL,
            width: captureWidth,
            height: captureHeight,
            includeAudio: includeAudio
        )

        // Create stream output handler
        let output = RecorderStreamOutput(
            assetWriter: writer,
            videoInput: videoInput,
            audioInput: audioInput
        )
        streamOutput = output

        // Create and start stream
        let captureStream = SCStream(filter: filter, configuration: config, delegate: nil)
        do {
            try captureStream.addStreamOutput(output, type: .screen, sampleHandlerQueue: output.queue)
            if includeAudio {
                try captureStream.addStreamOutput(output, type: .audio, sampleHandlerQueue: output.queue)
            }
            try await captureStream.startCapture()
        } catch {
            // Clean up on failure
            outputFileURL = nil
            streamOutput = nil
            try? FileManager.default.removeItem(at: fileURL)
            throw RecorderError.streamStartFailed(error)
        }

        stream = captureStream
        isRecording = true
        log.info("Recording started — output: \(fileURL.path)")
    }

    /// Stop recording and return the result.
    func stop() async throws -> RecordingResult {
        guard isRecording, let captureStream = stream else {
            throw RecorderError.notRecording
        }

        log.info("Stopping recording...")

        // Stop the capture stream
        try await captureStream.stopCapture()
        stream = nil
        isRecording = false

        // Finalize the asset writer
        guard let output = streamOutput else {
            throw RecorderError.notRecording
        }

        // If no video frames were ever captured, the output file is invalid
        guard output.didCaptureFrames else {
            // Cancel the asset writer to release the file handle before deletion
            output.assetWriter.cancelWriting()
            // Clean up the empty output file
            if let url = outputFileURL {
                try? FileManager.default.removeItem(at: url)
            }
            streamOutput = nil
            outputFileURL = nil
            throw RecorderError.noFramesCaptured
        }

        await output.finishWriting()

        // Read sample times from the output on its serial queue to avoid data races
        let (firstTime, lastTime) = await withCheckedContinuation { (continuation: CheckedContinuation<(CMTime?, CMTime?), Never>) in
            output.queue.async {
                continuation.resume(returning: (output.firstSampleTime, output.lastVideoSampleTime))
            }
        }

        let filePath = outputFileURL?.path ?? ""
        let durationMs = computeDurationMs(start: firstTime, end: lastTime)

        // Clean up references
        streamOutput = nil
        outputFileURL = nil

        log.info("Recording stopped — duration: \(durationMs)ms, file: \(filePath)")

        return RecordingResult(filePath: filePath, durationMs: durationMs)
    }

    // MARK: - Private Helpers

    private func buildFilter(
        scope: String,
        displayId: String?,
        windowId: Double?,
        content: SCShareableContent
    ) throws -> (SCContentFilter, Int, Int) {
        if scope == "window" {
            guard let wid = windowId else {
                throw RecorderError.noMatchingWindow
            }
            let targetWindowId = CGWindowID(wid)
            guard let window = content.windows.first(where: { $0.windowID == targetWindowId }) else {
                throw RecorderError.noMatchingWindow
            }
            let filter = SCContentFilter(desktopIndependentWindow: window)
            let scaleFactor = Int(NSScreen.main?.backingScaleFactor ?? 2.0)
            let width = Int(window.frame.width) * scaleFactor
            let height = Int(window.frame.height) * scaleFactor
            return (filter, max(width, 1), max(height, 1))
        }

        // Display capture (default)
        let display: SCDisplay
        if let idStr = displayId, let parsed = UInt32(idStr) {
            // Explicit displayId provided — must match exactly
            guard let matched = content.displays.first(where: { $0.displayID == parsed }) else {
                throw RecorderError.noMatchingDisplay
            }
            display = matched
        } else {
            // No displayId provided — use main display, fall back to first available
            let mainId = CGMainDisplayID()
            guard let fallback = content.displays.first(where: { $0.displayID == mainId })
                    ?? content.displays.first else {
                throw RecorderError.noMatchingDisplay
            }
            display = fallback
        }

        // Exclude our own app's windows so the recorder never captures itself
        let myPID = ProcessInfo.processInfo.processIdentifier
        let ownApps = content.applications.filter { $0.processID == myPID }
        let filter = SCContentFilter(display: display, excludingApplications: ownApps, exceptingWindows: [])
        return (filter, display.width, display.height)
    }

    private func prepareOutputFile() throws -> URL {
        let fileManager = FileManager.default
        guard let appSupport = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else {
            throw RecorderError.writerSetupFailed("Cannot locate Application Support directory")
        }
        let recordingsDir = appSupport.appendingPathComponent("vellum-assistant/recordings", isDirectory: true)

        if !fileManager.fileExists(atPath: recordingsDir.path) {
            try fileManager.createDirectory(at: recordingsDir, withIntermediateDirectories: true)
        }

        let fileName = "recording-\(UUID().uuidString).mov"
        return recordingsDir.appendingPathComponent(fileName)
    }

    private func setupAssetWriter(
        outputURL: URL,
        width: Int,
        height: Int,
        includeAudio: Bool
    ) throws -> (AVAssetWriter, AVAssetWriterInput, AVAssetWriterInput?) {
        let writer: AVAssetWriter
        do {
            writer = try AVAssetWriter(outputURL: outputURL, fileType: .mov)
        } catch {
            throw RecorderError.writerSetupFailed("AVAssetWriter init failed: \(error.localizedDescription)")
        }

        // Video input
        let videoSettings: [String: Any] = [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: width,
            AVVideoHeightKey: height
        ]
        let videoInput = AVAssetWriterInput(mediaType: .video, outputSettings: videoSettings)
        videoInput.expectsMediaDataInRealTime = true

        guard writer.canAdd(videoInput) else {
            throw RecorderError.writerSetupFailed("Cannot add video input to asset writer")
        }
        writer.add(videoInput)

        // Audio input (optional)
        var audioInput: AVAssetWriterInput?
        if includeAudio {
            let audioSettings: [String: Any] = [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVSampleRateKey: 48000,
                AVNumberOfChannelsKey: 2,
                AVEncoderBitRateKey: 128000
            ]
            let input = AVAssetWriterInput(mediaType: .audio, outputSettings: audioSettings)
            input.expectsMediaDataInRealTime = true

            if writer.canAdd(input) {
                writer.add(input)
                audioInput = input
            } else {
                log.warning("Cannot add audio input to asset writer, proceeding without audio")
            }
        }

        return (writer, videoInput, audioInput)
    }

    private func computeDurationMs(start: CMTime?, end: CMTime?) -> Double {
        guard let start = start, let end = end else { return 0 }
        let seconds = CMTimeGetSeconds(end) - CMTimeGetSeconds(start)
        return max(seconds * 1000, 0)
    }
}

// MARK: - Stream Output Handler

/// Receives sample buffers from SCStream on a background queue and writes them to AVAssetWriter.
/// This class is NOT @MainActor — it handles callbacks on its own dispatch queue.
private final class RecorderStreamOutput: NSObject, SCStreamOutput, @unchecked Sendable {
    let queue = DispatchQueue(label: "com.vellum.vellum-assistant.screen-recorder", qos: .userInitiated)

    let assetWriter: AVAssetWriter
    private let videoInput: AVAssetWriterInput
    private let audioInput: AVAssetWriterInput?

    private var hasStartedSession = false

    /// Whether at least one video frame was captured and written.
    var didCaptureFrames: Bool { hasStartedSession }

    /// Presentation time of the first captured video frame (set on queue).
    private(set) var firstSampleTime: CMTime?
    /// Presentation time of the most recent captured video frame (set on queue).
    private(set) var lastVideoSampleTime: CMTime?

    init(assetWriter: AVAssetWriter, videoInput: AVAssetWriterInput, audioInput: AVAssetWriterInput?) {
        self.assetWriter = assetWriter
        self.videoInput = videoInput
        self.audioInput = audioInput
        super.init()
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard sampleBuffer.isValid else { return }

        // Start the writer session on the first valid video frame
        if !hasStartedSession && type == .screen {
            let time = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
            guard assetWriter.startWriting() else {
                log.error("Asset writer failed to start: \(self.assetWriter.error?.localizedDescription ?? "unknown error")")
                return
            }
            assetWriter.startSession(atSourceTime: time)
            hasStartedSession = true
            firstSampleTime = time
        }

        guard hasStartedSession else { return }

        switch type {
        case .screen:
            if videoInput.isReadyForMoreMediaData {
                videoInput.append(sampleBuffer)
                lastVideoSampleTime = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
            }
        case .audio:
            if let audioInput = audioInput, audioInput.isReadyForMoreMediaData {
                audioInput.append(sampleBuffer)
            }
        @unknown default:
            break
        }
    }

    /// Finishes writing and waits for the asset writer to complete.
    /// markAsFinished() is dispatched onto self.queue to avoid racing with append().
    func finishWriting() async {
        guard hasStartedSession else { return }
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            queue.async {
                self.videoInput.markAsFinished()
                self.audioInput?.markAsFinished()
                continuation.resume()
            }
        }
        await assetWriter.finishWriting()
    }
}
