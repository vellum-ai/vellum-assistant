import Foundation
import ScreenCaptureKit
import AVFoundation
import CoreMedia
import os

private let log = Logger(subsystem: "com.vellum.vellum-assistant", category: "ScreenRecorder")

// MARK: - Recording Result

/// Metadata returned after a screen recording session completes.
struct RecordingResult: Sendable {
    let fileURL: URL
    let mimeType: String  // always "video/mp4"
    let sizeBytes: Int
    let durationMs: Int
    let width: Int
    let height: Int
    let captureScope: String  // "window" or "display"
    let includeAudio: Bool
    let targetBundleId: String?
}

// MARK: - Recording Errors

enum ScreenRecorderError: LocalizedError {
    case alreadyRecording
    case notRecording
    case permissionDenied
    case noDisplayFound
    case windowNotFound(CGWindowID)
    case assetWriterSetupFailed(String)
    case assetWriterFailed(String)
    case recordingDirectoryCreationFailed

    var errorDescription: String? {
        switch self {
        case .alreadyRecording:
            return "Screen recording is already in progress"
        case .notRecording:
            return "No active screen recording to stop"
        case .permissionDenied:
            return "Screen Recording permission denied. Grant it in System Settings > Privacy & Security > Screen Recording."
        case .noDisplayFound:
            return "No display found for recording"
        case .windowNotFound(let id):
            return "Window with ID \(id) not found for recording"
        case .assetWriterSetupFailed(let reason):
            return "Failed to set up recording writer: \(reason)"
        case .assetWriterFailed(let reason):
            return "Recording writer error: \(reason)"
        case .recordingDirectoryCreationFailed:
            return "Failed to create recordings directory"
        }
    }
}

// MARK: - Protocol

/// Protocol for screen recording, enabling dependency injection and testing.
@MainActor
protocol ScreenRecording {
    func startRecording(windowID: CGWindowID?, displayID: CGDirectDisplayID?, includeAudio: Bool) async throws
    func stopRecording() async throws -> RecordingResult
    func waitForFirstFrame(timeoutSeconds: Double) async -> Bool
    var isRecording: Bool { get }
}

extension ScreenRecording {
    func waitForFirstFrame(timeoutSeconds: Double = 5.0) async -> Bool {
        return true  // Mocks assume healthy capture by default
    }
}

// MARK: - ScreenRecorder

/// Records screen content to an .mp4 file using ScreenCaptureKit (SCStream).
///
/// Supports two capture scopes:
/// - **Window capture**: captures a specific window by CGWindowID
/// - **Display capture**: captures the full display (fallback)
///
/// Recordings are saved to `~/Library/Application Support/vellum-assistant/recordings/`.
@MainActor
final class ScreenRecorder: NSObject, ScreenRecording {
    private(set) var isRecording = false
    /// The file URL of the last recording attempt, available even after failure for salvage.
    private(set) var lastRecordingFileURL: URL?

    private var stream: SCStream?
    private var assetWriter: AVAssetWriter?
    private var videoInput: AVAssetWriterInput?
    private var audioInput: AVAssetWriterInput?
    private var recordingFileURL: URL?
    private var recordingStartTime: Date?
    private var captureScope: String = "display"
    private var includesAudio: Bool = false
    private var targetBundleId: String?
    private var captureWidth: Int = 0
    private var captureHeight: Int = 0

    /// Nonisolated delegate that buffers samples and forwards them to the asset writer.
    /// Must be nonisolated because SCStreamOutput callbacks arrive on an arbitrary queue.
    private var outputHandler: StreamOutputHandler?

    // MARK: - Directory Setup

    private static func recordingsDirectory() throws -> URL {
        let appSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        let recordingsDir = appSupport
            .appendingPathComponent("vellum-assistant", isDirectory: true)
            .appendingPathComponent("recordings", isDirectory: true)

        if !FileManager.default.fileExists(atPath: recordingsDir.path) {
            do {
                try FileManager.default.createDirectory(at: recordingsDir, withIntermediateDirectories: true)
            } catch {
                log.error("Failed to create recordings directory: \(error.localizedDescription)")
                throw ScreenRecorderError.recordingDirectoryCreationFailed
            }
        }

        return recordingsDir
    }

    // MARK: - Start Recording

    func startRecording(windowID: CGWindowID? = nil, displayID: CGDirectDisplayID? = nil, includeAudio: Bool = false) async throws {
        guard !isRecording else {
            throw ScreenRecorderError.alreadyRecording
        }

        // Fetch shareable content (triggers permission prompt if needed)
        let content: SCShareableContent
        do {
            content = try await SCShareableContent.current
        } catch {
            throw ScreenRecorderError.permissionDenied
        }

        // Build content filter based on capture scope
        let filter: SCContentFilter
        if let windowID, let window = content.windows.first(where: { $0.windowID == windowID }) {
            filter = SCContentFilter(desktopIndependentWindow: window)
            captureScope = "window"
            targetBundleId = window.owningApplication?.bundleIdentifier
            log.info("Recording window \(windowID) (bundle: \(self.targetBundleId ?? "unknown"))")
        } else if let displayID, let display = content.displays.first(where: { $0.displayID == displayID }) {
            // Exclude our own app's windows from display capture
            let myPID = ProcessInfo.processInfo.processIdentifier
            let ownWindows = content.windows.filter { $0.owningApplication?.processID == myPID }
            filter = SCContentFilter(display: display, excludingWindows: ownWindows)
            captureScope = "display"
            targetBundleId = nil
            log.info("Recording display \(displayID)")
        } else {
            // Fallback: use main display
            let mainDisplayID = CGMainDisplayID()
            guard let display = content.displays.first(where: { $0.displayID == mainDisplayID })
                    ?? content.displays.first else {
                throw ScreenRecorderError.noDisplayFound
            }
            let myPID = ProcessInfo.processInfo.processIdentifier
            let ownWindows = content.windows.filter { $0.owningApplication?.processID == myPID }
            filter = SCContentFilter(display: display, excludingWindows: ownWindows)
            captureScope = "display"
            targetBundleId = nil
            log.info("Recording main display (fallback)")
        }

        includesAudio = includeAudio

        // Configure the stream
        let config = SCStreamConfiguration()
        config.width = 1920
        config.height = 1080
        config.pixelFormat = kCVPixelFormatType_32BGRA
        config.showsCursor = true
        config.minimumFrameInterval = CMTime(value: 1, timescale: 30) // 30 fps

        if includeAudio {
            config.capturesAudio = true
            config.sampleRate = 44100
            config.channelCount = 2
        }

        captureWidth = config.width
        captureHeight = config.height

        // Set up the output file
        let recordingsDir = try Self.recordingsDirectory()
        let timestamp = ISO8601DateFormatter().string(from: Date())
            .replacingOccurrences(of: ":", with: "-")
        let fileName = "qa-recording-\(timestamp).mp4"
        let fileURL = recordingsDir.appendingPathComponent(fileName)
        recordingFileURL = fileURL
        lastRecordingFileURL = fileURL

        // Set up AVAssetWriter
        let writer: AVAssetWriter
        do {
            writer = try AVAssetWriter(outputURL: fileURL, fileType: .mp4)
        } catch {
            throw ScreenRecorderError.assetWriterSetupFailed(error.localizedDescription)
        }

        // Video input
        let videoSettings: [String: Any] = [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: config.width,
            AVVideoHeightKey: config.height,
            AVVideoCompressionPropertiesKey: [
                AVVideoAverageBitRateKey: 4_000_000,  // 4 Mbps
                AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
            ]
        ]
        let vInput = AVAssetWriterInput(mediaType: .video, outputSettings: videoSettings)
        vInput.expectsMediaDataInRealTime = true
        guard writer.canAdd(vInput) else {
            throw ScreenRecorderError.assetWriterSetupFailed("Cannot add video input to asset writer")
        }
        writer.add(vInput)
        videoInput = vInput

        // Audio input (optional)
        if includeAudio {
            let audioSettings: [String: Any] = [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVSampleRateKey: 44100,
                AVNumberOfChannelsKey: 2,
                AVEncoderBitRateKey: 128_000,
            ]
            let aInput = AVAssetWriterInput(mediaType: .audio, outputSettings: audioSettings)
            aInput.expectsMediaDataInRealTime = true
            if writer.canAdd(aInput) {
                writer.add(aInput)
                audioInput = aInput
            }
        }

        writer.startWriting()
        assetWriter = writer

        // Create the nonisolated output handler
        let handler = StreamOutputHandler(writer: writer, videoInput: vInput, audioInput: audioInput)
        outputHandler = handler

        // Create and start the stream
        let scStream = SCStream(filter: filter, configuration: config, delegate: nil)
        try scStream.addStreamOutput(handler, type: .screen, sampleHandlerQueue: .global(qos: .userInitiated))
        if includeAudio {
            try scStream.addStreamOutput(handler, type: .audio, sampleHandlerQueue: .global(qos: .userInitiated))
        }

        try await scStream.startCapture()
        stream = scStream
        isRecording = true
        recordingStartTime = Date()

        log.info("Screen recording started: \(fileURL.lastPathComponent)")
    }

    // MARK: - First Frame Handshake

    /// Waits for the first video frame to arrive, returning true if received within the timeout.
    func waitForFirstFrame(timeoutSeconds: Double = 5.0) async -> Bool {
        guard let handler = outputHandler else { return false }

        return await withTaskGroup(of: Bool.self) { group in
            group.addTask {
                await withCheckedContinuation { continuation in
                    handler.setFirstFrameContinuation(continuation)
                }
                return true
            }
            group.addTask {
                try? await Task.sleep(nanoseconds: UInt64(timeoutSeconds * 1_000_000_000))
                handler.cancelFirstFrameWait()
                return false
            }
            let result = await group.next() ?? false
            group.cancelAll()
            return result
        }
    }

    // MARK: - Stop Recording

    func stopRecording() async throws -> RecordingResult {
        guard isRecording, let stream, let writer = assetWriter, let fileURL = recordingFileURL else {
            throw ScreenRecorderError.notRecording
        }

        // Capture values needed for result computation before cleanup
        let capturedStream = stream
        let capturedWriter = writer
        let capturedFileURL = fileURL
        let capturedStartTime = recordingStartTime
        let capturedVideoInput = videoInput
        let capturedAudioInput = audioInput
        let capturedWidth = captureWidth
        let capturedHeight = captureHeight
        let capturedScope = captureScope
        let capturedIncludesAudio = includesAudio
        let capturedTargetBundleId = targetBundleId

        // Guarantee state cleanup on all paths (including throws)
        defer {
            self.stream = nil
            self.assetWriter = nil
            self.videoInput = nil
            self.audioInput = nil
            self.outputHandler = nil
            self.recordingFileURL = nil
            self.recordingStartTime = nil
            self.isRecording = false
        }

        // Stop the stream capture
        do {
            try await capturedStream.stopCapture()
        } catch {
            log.warning("Error stopping stream capture: \(error.localizedDescription)")
        }

        // Mark inputs as finished
        capturedVideoInput?.markAsFinished()
        capturedAudioInput?.markAsFinished()

        // Finalize the asset writer
        await capturedWriter.finishWriting()

        if capturedWriter.status == .failed {
            let writerError = capturedWriter.error
            let nsError = writerError as? NSError
            let errorMsg = writerError?.localizedDescription ?? "Unknown error"
            let domain = nsError?.domain ?? "unknown"
            let code = nsError?.code ?? -1
            log.error("Asset writer failed: \(errorMsg) (domain=\(domain), code=\(code))")
            throw ScreenRecorderError.assetWriterFailed(errorMsg)
        }

        // Compute metadata
        let fileAttributes = try FileManager.default.attributesOfItem(atPath: capturedFileURL.path)
        let sizeBytes = (fileAttributes[.size] as? Int) ?? 0

        // Compute duration from the asset
        let asset = AVAsset(url: capturedFileURL)
        let duration: CMTime
        if let tracks = try? await asset.load(.tracks), !tracks.isEmpty {
            duration = try await asset.load(.duration)
        } else {
            // Fallback: estimate from wall clock time
            let elapsed = capturedStartTime.map { Date().timeIntervalSince($0) } ?? 0
            duration = CMTime(seconds: elapsed, preferredTimescale: 1000)
        }
        let durationMs = Int(CMTimeGetSeconds(duration) * 1000)

        let result = RecordingResult(
            fileURL: capturedFileURL,
            mimeType: "video/mp4",
            sizeBytes: sizeBytes,
            durationMs: durationMs,
            width: capturedWidth,
            height: capturedHeight,
            captureScope: capturedScope,
            includeAudio: capturedIncludesAudio,
            targetBundleId: capturedTargetBundleId
        )

        log.info("Screen recording stopped: \(capturedFileURL.lastPathComponent) (\(sizeBytes) bytes, \(durationMs)ms)")

        return result
    }
}

// MARK: - Stream Output Handler

/// Nonisolated handler for SCStream output that writes samples to an AVAssetWriter.
/// SCStreamOutput callbacks arrive on arbitrary queues, so this class must not be
/// @MainActor-isolated.
private final class StreamOutputHandler: NSObject, SCStreamOutput, @unchecked Sendable {
    private let writer: AVAssetWriter
    private let videoInput: AVAssetWriterInput
    private let audioInput: AVAssetWriterInput?
    private var sessionStarted = false
    private let lock = NSLock()
    private var firstFrameContinuation: CheckedContinuation<Void, Never>?
    private let firstFrameLock = NSLock()

    init(writer: AVAssetWriter, videoInput: AVAssetWriterInput, audioInput: AVAssetWriterInput?) {
        self.writer = writer
        self.videoInput = videoInput
        self.audioInput = audioInput
        super.init()
    }

    func setFirstFrameContinuation(_ continuation: CheckedContinuation<Void, Never>?) {
        firstFrameLock.lock()
        defer { firstFrameLock.unlock() }
        firstFrameContinuation = continuation
    }

    func cancelFirstFrameWait() {
        firstFrameLock.lock()
        defer { firstFrameLock.unlock() }
        firstFrameContinuation = nil
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard writer.status == .writing else { return }
        guard sampleBuffer.isValid else { return }

        lock.lock()
        defer { lock.unlock() }

        // Start the session on the first sample
        if !sessionStarted {
            let timestamp = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
            writer.startSession(atSourceTime: timestamp)
            sessionStarted = true

            // Signal that the first frame has been received
            firstFrameLock.lock()
            let cont = firstFrameContinuation
            firstFrameContinuation = nil
            firstFrameLock.unlock()
            cont?.resume()
        }

        switch type {
        case .screen:
            if videoInput.isReadyForMoreMediaData {
                videoInput.append(sampleBuffer)
            }
        case .audio:
            if let audioInput, audioInput.isReadyForMoreMediaData {
                audioInput.append(sampleBuffer)
            }
        @unknown default:
            break
        }
    }
}
