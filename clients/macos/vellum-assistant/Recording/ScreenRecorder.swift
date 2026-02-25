import AppKit
import AVFoundation
import ScreenCaptureKit
import VideoToolbox
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "ScreenRecorder")

/// Result of a completed recording.
struct RecordingResult: Sendable {
    let filePath: String
    let durationMs: Int
}

/// Encoder configuration for a single fallback attempt.
struct EncodeConfig {
    let codec: AVVideoCodecType
    let width: Int
    let height: Int
    let label: String
}

/// Errors that can occur during screen recording.
enum RecorderError: Error, LocalizedError {
    case noMatchingDisplay
    case noMatchingWindow
    case streamStartFailed(String)
    case writerSetupFailed(String)
    case notRecording
    case noFramesCaptured
    case allFallbacksExhausted
    case unsupportedDimensions(width: Int, height: Int)
    case sourceUnavailable(String)
    case permissionDenied
    case sessionInterrupted(String)

    var errorDescription: String? {
        switch self {
        case .noMatchingDisplay: return "The selected display is no longer available. It may have been unplugged or reconfigured."
        case .noMatchingWindow: return "The selected window is no longer available. It may have been closed or moved to a different space."
        case .streamStartFailed(let reason): return "Failed to start screen capture stream: \(reason)"
        case .writerSetupFailed(let reason): return "Failed to set up video writer: \(reason)"
        case .notRecording: return "No active recording to stop"
        case .noFramesCaptured: return "Recording produced no video frames"
        case .allFallbacksExhausted: return "All encoder fallback configurations failed — unable to record"
        case .unsupportedDimensions(let width, let height): return "Recording dimensions \(width)x\(height) exceed codec limits"
        case .sourceUnavailable(let reason): return "Recording source became unavailable: \(reason)"
        case .permissionDenied: return "Screen recording permission was not granted or has been revoked"
        case .sessionInterrupted(let reason): return "Recording session was interrupted: \(reason)"
        }
    }
}

/// Result of normalizing capture dimensions for encoder compatibility.
struct NormalizedDimensions {
    let width: Int
    let height: Int
    let wasAdjusted: Bool
    let adjustmentReason: String?
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

    /// The display being recorded (nil for window captures). Used by the
    /// display reconfiguration callback to detect removal or resolution changes.
    private var recordedDisplayID: CGDirectDisplayID?

    /// Label of the encode config that was successfully used, for telemetry (M9).
    private(set) var activeConfigLabel: String?

    /// Callback invoked when the SCStream stops with an error mid-recording.
    /// RecordingManager sets this to react to stream failures (update state, send IPC, clean up).
    var onStreamError: ((RecorderError) -> Void)?

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

    /// Resolve the backing scale factor for a display.
    ///
    /// Tries `NSScreen.backingScaleFactor` for the matching screen first,
    /// then falls back to computing the ratio from `CGDisplayPixelsWide`
    /// (native pixels) vs `CGDisplayBounds` logical width. Returns 2 as
    /// a last resort.
    private static func scaleFactor(for displayID: CGDirectDisplayID) -> CGFloat {
        if let screen = NSScreen.screens.first(where: {
            // NSScreen's deviceDescription contains the CGDirectDisplayID under the "NSScreenNumber" key
            ($0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? CGDirectDisplayID) == displayID
        }) {
            return screen.backingScaleFactor
        }

        // Fallback: derive scale from native pixel width vs display logical width
        let nativeWidth = CGDisplayPixelsWide(displayID)
        let logicalWidth = Int(CGDisplayBounds(displayID).width)
        if logicalWidth > 0 && nativeWidth > 0 {
            return CGFloat(nativeWidth) / CGFloat(logicalWidth)
        }

        log.warning("Could not determine scale factor for displayID=\(displayID) — defaulting to 2x")
        return 2.0
    }

    // MARK: - Dimension Normalization

    /// Normalize capture dimensions to satisfy H.264/HEVC encoder constraints.
    ///
    /// Ensures dimensions are even (macroblock alignment), at least 128px
    /// (H.264 minimum), and at most `maxDimension` px (real-time encoding
    /// limit). When the source exceeds `maxDimension`, both axes are scaled
    /// down proportionally to preserve aspect ratio.
    static func normalizeDimensions(width: Int, height: Int, maxDimension: Int = 4096) -> NormalizedDimensions {
        var w = width
        var h = height
        var reasons: [String] = []

        // 1. Enforce minimum (128px per axis)
        let minDimension = 128
        if w < minDimension || h < minDimension {
            w = max(w, minDimension)
            h = max(h, minDimension)
            reasons.append("clamped below-minimum axis to \(minDimension)px")
        }

        // 2. Enforce maximum — scale down proportionally if either axis exceeds the limit
        if w > maxDimension || h > maxDimension {
            let scale = Double(maxDimension) / Double(max(w, h))
            w = Int((Double(w) * scale).rounded(.down))
            h = Int((Double(h) * scale).rounded(.down))
            reasons.append("scaled down to fit \(maxDimension)px limit")
        }

        // 2b. Re-apply minimum after downscaling — extreme aspect ratios can
        //     push the shorter axis below 128px (e.g. 8192x128 → 4096x64).
        if w < minDimension || h < minDimension {
            w = max(w, minDimension)
            h = max(h, minDimension)
            reasons.append("re-clamped below-minimum axis after downscale")
        }

        // 3. Round up to nearest even value (H.264 macroblock requirement)
        if w % 2 != 0 || h % 2 != 0 {
            w = (w + 1) & ~1
            h = (h + 1) & ~1
            reasons.append("rounded to even dimensions")
        }

        let wasAdjusted = w != width || h != height
        let reason = wasAdjusted ? reasons.joined(separator: "; ") : nil

        if wasAdjusted {
            log.info("Dimension normalization: \(width)x\(height) → \(w)x\(h) (\(reason!, privacy: .public))")
        }

        return NormalizedDimensions(width: w, height: h, wasAdjusted: wasAdjusted, adjustmentReason: reason)
    }

    // MARK: - Fallback Configs

    /// Build an ordered list of encoder fallback configurations.
    ///
    /// Each config's dimensions are normalized through `normalizeDimensions`
    /// before use. The order is:
    /// 1. H.264 at primary (source) dimensions
    /// 2. H.264 at halved dimensions (2x downscale)
    /// 3. HEVC at primary dimensions (only if hardware-supported)
    /// 4. H.264 at 1280x720 (conservative safe config)
    static func buildFallbackConfigs(primaryWidth: Int, primaryHeight: Int) -> [EncodeConfig] {
        let primary = normalizeDimensions(width: primaryWidth, height: primaryHeight)

        let halfW = max(primaryWidth / 2, 1)
        let halfH = max(primaryHeight / 2, 1)
        let halved = normalizeDimensions(width: halfW, height: halfH)

        let safe = normalizeDimensions(width: 1280, height: 720)

        var configs: [EncodeConfig] = [
            EncodeConfig(codec: .h264, width: primary.width, height: primary.height, label: "primary"),
            EncodeConfig(codec: .h264, width: halved.width, height: halved.height, label: "fallback-half"),
        ]

        // Only offer HEVC if hardware decode is available (proxy for hardware encode support)
        if VTIsHardwareDecodeSupported(kCMVideoCodecType_HEVC) {
            configs.append(EncodeConfig(codec: .hevc, width: primary.width, height: primary.height, label: "fallback-hevc"))
        }

        configs.append(EncodeConfig(codec: .h264, width: safe.width, height: safe.height, label: "fallback-720p"))

        return configs
    }

    // MARK: - Start Recording

    /// Start recording the screen or a specific window.
    ///
    /// Iterates through encoder fallback configurations if the primary config
    /// fails (writer setup error or no frames received within 3 seconds).
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

            // Find the display containing this window so we can use its actual scale factor
            let windowMidX = window.frame.midX
            let windowMidY = window.frame.midY
            var windowDisplayID = CGMainDisplayID()
            for display in shareable.displays {
                let displayBounds = CGDisplayBounds(display.displayID)
                if displayBounds.contains(CGPoint(x: windowMidX, y: windowMidY)) {
                    windowDisplayID = display.displayID
                    break
                }
            }
            let windowScale = Self.scaleFactor(for: windowDisplayID)
            captureWidth = Int(CGFloat(window.frame.width) * windowScale)
            captureHeight = Int(CGFloat(window.frame.height) * windowScale)
            log.info("Window capture: windowID=\(windowId), displayID=\(windowDisplayID), scaleFactor=\(windowScale), sourceSize=\(Int(window.frame.width))x\(Int(window.frame.height)), streamSize=\(captureWidth)x\(captureHeight)")
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
            let displayScale = Self.scaleFactor(for: targetDisplay.displayID)
            captureWidth = Int(CGFloat(targetDisplay.width) * displayScale)
            captureHeight = Int(CGFloat(targetDisplay.height) * displayScale)
            log.info("Display capture: displayID=\(targetDisplay.displayID), scaleFactor=\(displayScale), sourceSize=\(targetDisplay.width)x\(targetDisplay.height), streamSize=\(captureWidth)x\(captureHeight)")

            // Monitor this display for reconfiguration (unplug, resolution change)
            registerDisplayReconfiguration(for: targetDisplay.displayID)
        }

        let fallbackConfigs = Self.buildFallbackConfigs(primaryWidth: captureWidth, primaryHeight: captureHeight)
        log.info("Encoder fallback chain: \(fallbackConfigs.map { "\($0.label)(\($0.width)x\($0.height))" }.joined(separator: " → "), privacy: .public)")

        try Self.ensureRecordingsDirectory()

        for (index, encodeConfig) in fallbackConfigs.enumerated() {
            let isLastConfig = index == fallbackConfigs.count - 1
            log.info("Trying encoder config [\(index + 1)/\(fallbackConfigs.count)]: \(encodeConfig.label, privacy: .public) — codec=\(encodeConfig.codec.rawValue, privacy: .public), \(encodeConfig.width)x\(encodeConfig.height)")

            let attemptResult = await attemptStartWithConfig(
                encodeConfig: encodeConfig,
                filter: filter,
                includeAudio: includeAudio,
                includeMicrophone: includeMicrophone
            )

            switch attemptResult {
            case .success:
                activeConfigLabel = encodeConfig.label
                log.info("Encoder config '\(encodeConfig.label, privacy: .public)' succeeded")
                return
            case .writerSetupFailed(let reason):
                log.warning("Encoder config '\(encodeConfig.label, privacy: .public)' failed: writer setup error — \(reason, privacy: .public)")
                if isLastConfig {
                    throw RecorderError.allFallbacksExhausted
                }
            case .noFramesReceived:
                log.warning("Encoder config '\(encodeConfig.label, privacy: .public)' failed: no frames received within timeout")
                if isLastConfig {
                    throw RecorderError.allFallbacksExhausted
                }
            case .streamStartFailed(let reason):
                log.warning("Encoder config '\(encodeConfig.label, privacy: .public)' failed: stream start error — \(reason, privacy: .public)")
                if isLastConfig {
                    throw RecorderError.allFallbacksExhausted
                }
            }
        }

        // Should not reach here — the loop either returns on success or throws on last failure
        throw RecorderError.allFallbacksExhausted
    }

    // MARK: - Fallback Attempt

    /// Result of a single encoder config attempt.
    private enum AttemptResult {
        case success
        case writerSetupFailed(String)
        case noFramesReceived
        case streamStartFailed(String)
    }

    /// Try to start recording with a single encoder configuration.
    ///
    /// Sets up the AVAssetWriter, stream, and waits up to 3 seconds for the
    /// first video frame. On failure, tears down partial state and returns
    /// a non-success result so the caller can try the next config.
    private func attemptStartWithConfig(
        encodeConfig: EncodeConfig,
        filter: SCContentFilter,
        includeAudio: Bool,
        includeMicrophone: Bool
    ) async -> AttemptResult {
        // Clean up any previous attempt state
        cleanUpWriter()
        stream = nil

        let encoderWidth = encodeConfig.width
        let encoderHeight = encodeConfig.height

        // Configure stream — dimensions match the encoder config so ScreenCaptureKit
        // delivers frames at the size the writer expects.
        let config = SCStreamConfiguration()
        config.width = encoderWidth
        config.height = encoderHeight
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

        // Each attempt gets a unique output file so failed attempts don't conflict
        let timestamp = ISO8601DateFormatter().string(from: Date()).replacingOccurrences(of: ":", with: "-")
        let outputURL = Self.recordingsDirectory.appendingPathComponent("recording-\(timestamp)-\(UUID().uuidString.prefix(8)).mov")

        let writer: AVAssetWriter
        do {
            writer = try AVAssetWriter(outputURL: outputURL, fileType: .mov)
        } catch {
            return .writerSetupFailed(error.localizedDescription)
        }

        // Video input
        let videoSettings: [String: Any] = [
            AVVideoCodecKey: encodeConfig.codec,
            AVVideoWidthKey: encoderWidth,
            AVVideoHeightKey: encoderHeight,
        ]
        let vInput = AVAssetWriterInput(mediaType: .video, outputSettings: videoSettings)
        vInput.expectsMediaDataInRealTime = true
        if writer.canAdd(vInput) {
            writer.add(vInput)
        } else {
            // Remove the empty output file
            try? FileManager.default.removeItem(at: outputURL)
            return .writerSetupFailed("writer rejected video input with codec=\(encodeConfig.codec.rawValue)")
        }
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

        // Microphone input: AAC (optional — separate track, macOS 15+)
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

        let codecName = encodeConfig.codec == .hevc ? "HEVC" : "H.264"
        log.info("Encoder settings: codec=\(codecName, privacy: .public), pixelFormat=32BGRA, frameRate=30fps, dimensions=\(encoderWidth)x\(encoderHeight), config=\(encodeConfig.label, privacy: .public)")
        if includeAudio {
            log.info("System audio: sampleRate=48000, channels=2, bitRate=128000")
        }
        if includeMicrophone {
            if #available(macOS 15, *) {
                log.info("Microphone audio: sampleRate=48000, channels=1, bitRate=64000")
            } else {
                log.info("Microphone requested but macOS 15+ required — skipped")
            }
        }

        // Create stream and output delegate
        let delegate = StreamOutputDelegate(recorder: self)
        self.outputDelegate = delegate

        let captureStream = SCStream(filter: filter, configuration: config, delegate: delegate)

        do {
            try captureStream.addStreamOutput(delegate, type: .screen, sampleHandlerQueue: outputQueue)
            if includeAudio {
                try captureStream.addStreamOutput(delegate, type: .audio, sampleHandlerQueue: outputQueue)
            }
            if includeMicrophone, #available(macOS 15, *) {
                try captureStream.addStreamOutput(delegate, type: .microphone, sampleHandlerQueue: outputQueue)
            }
        } catch {
            try? FileManager.default.removeItem(at: outputURL)
            cleanUpWriter()
            return .streamStartFailed(error.localizedDescription)
        }

        self.stream = captureStream

        // Start capture
        do {
            try await captureStream.startCapture()
        } catch {
            try? FileManager.default.removeItem(at: outputURL)
            self.stream = nil
            cleanUpWriter()
            return .streamStartFailed(error.localizedDescription)
        }

        isRecordingActive = true
        hasReceivedVideoFrame = false
        recordingStartDate = Date()
        log.info("Screen recording started → \(outputURL.path, privacy: .public)")

        // Wait up to 3 seconds for the first video frame to verify the encoder is working
        let frameTimeoutSeconds = 3.0
        let checkInterval: UInt64 = 100_000_000 // 100ms in nanoseconds
        let maxChecks = Int(frameTimeoutSeconds / 0.1)

        for _ in 0..<maxChecks {
            if hasReceivedVideoFrame {
                return .success
            }
            try? await Task.sleep(nanoseconds: checkInterval)
        }

        // Final check after the loop completes
        if hasReceivedVideoFrame {
            return .success
        }

        // No frames arrived — tear down this attempt
        log.warning("No video frames received after \(frameTimeoutSeconds)s for config '\(encodeConfig.label, privacy: .public)' — tearing down")
        if let s = stream {
            try? await s.stopCapture()
        }
        stream = nil
        assetWriter?.cancelWriting()
        try? FileManager.default.removeItem(at: outputURL)
        cleanUpWriter()

        return .noFramesReceived
    }

    // MARK: - Stop Recording

    /// Stop the active recording and return the result.
    ///
    /// - Returns: `RecordingResult` with the file path and duration.
    func stop() async throws -> RecordingResult {
        guard isRecordingActive else {
            throw RecorderError.notRecording
        }

        // Unregister display monitoring early to avoid the reconfiguration
        // callback racing with teardown.
        unregisterDisplayReconfiguration()

        // Stop the capture stream
        if let stream {
            try? await stream.stopCapture()
        }
        stream = nil

        guard hasReceivedVideoFrame else {
            log.error("Stop: no video frames captured — discarding recording")
            cleanUpWriter()
            throw RecorderError.noFramesCaptured
        }

        guard let writer = assetWriter else {
            throw RecorderError.notRecording
        }

        // Finish writing
        log.info("Stop: marking inputs finished (video=\(self.videoInput != nil), audio=\(self.audioInput != nil), mic=\(self.micInput != nil))")
        videoInput?.markAsFinished()
        audioInput?.markAsFinished()
        micInput?.markAsFinished()

        let outputURL = writer.outputURL

        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            writer.finishWriting {
                continuation.resume()
            }
        }

        let writerStatus = writer.status
        if writerStatus == .completed {
            log.info("Writer: finishWriting completed successfully")
        } else {
            log.error("Writer: finishWriting ended with status=\(writerStatus.rawValue), error=\(writer.error?.localizedDescription ?? "none")")
        }

        let durationMs: Int
        if let startDate = recordingStartDate {
            durationMs = Int(Date().timeIntervalSince(startDate) * 1000)
        } else {
            durationMs = 0
        }

        let fileSize = (try? FileManager.default.attributesOfItem(atPath: outputURL.path)[.size] as? Int) ?? 0

        cleanUpWriter()
        log.info("Recording complete — duration=\(durationMs)ms, fileSize=\(fileSize) bytes, file=\(outputURL.path, privacy: .public)")

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
                log.info("Writer: startWriting + startSession at pts=\(pts.seconds)s (status=\(writer.status.rawValue))")
            }

            guard writer.status == .writing else {
                log.error("Writer not in writing state: status=\(writer.status.rawValue), error=\(writer.error?.localizedDescription ?? "none")")
                return
            }

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

    // MARK: - Stream Error Handling

    /// Map an NSError from SCStream to a specific RecorderError case.
    static func mapStreamError(_ nsError: NSError) -> RecorderError {
        let domain = nsError.domain
        let code = nsError.code

        // ScreenCaptureKit errors use the "com.apple.screencapturekit.error" domain
        if domain == "com.apple.screencapturekit.error" {
            switch code {
            // Permission / user-denied errors
            case -3801, -3802, -3803:
                return .permissionDenied
            // Content filter errors — the source display/window is no longer available
            case -3804, -3805, -3806, -3807:
                return .sourceUnavailable(nsError.localizedDescription)
            // Session/capture interruption errors
            case -3808, -3809, -3810:
                return .sessionInterrupted(nsError.localizedDescription)
            default:
                return .sessionInterrupted("SCStream error \(code): \(nsError.localizedDescription)")
            }
        }

        // Fallback for other error domains
        return .sessionInterrupted(nsError.localizedDescription)
    }

    /// Called by the stream delegate when SCStream stops with an error.
    /// Cleans up the recording and notifies the owner via the onStreamError callback.
    nonisolated func handleStreamError(_ error: Error) {
        let nsError = error as NSError
        let recorderError = Self.mapStreamError(nsError)

        Task { @MainActor in
            guard isRecordingActive else { return }

            log.error("Stream error during active recording — cleaning up (error=\(recorderError.localizedDescription ?? "unknown", privacy: .public))")

            // Cancel the writer and remove the partial file
            assetWriter?.cancelWriting()
            if let outputURL = assetWriter?.outputURL {
                try? FileManager.default.removeItem(at: outputURL)
                log.info("Removed partial recording file: \(outputURL.path, privacy: .public)")
            }

            stream = nil
            cleanUpWriter()

            onStreamError?(recorderError)
        }
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
        activeConfigLabel = nil
        unregisterDisplayReconfiguration()
    }

    // MARK: - Display Reconfiguration Monitoring

    /// Register for CoreGraphics display reconfiguration notifications.
    ///
    /// Called when a display recording starts. Detects display removal and
    /// resolution changes while recording is active.
    private func registerDisplayReconfiguration(for displayID: CGDirectDisplayID) {
        recordedDisplayID = displayID
        // `Unmanaged.passUnretained(self).toOpaque()` passes `self` as the
        // user-info pointer without retaining, since the callback lifetime
        // is bounded by the recording session.
        CGDisplayRegisterReconfigurationCallback(displayReconfigurationCallback, Unmanaged.passUnretained(self).toOpaque())
        log.info("Registered display reconfiguration callback for displayID=\(displayID)")
    }

    /// Unregister the CoreGraphics display reconfiguration callback.
    private func unregisterDisplayReconfiguration() {
        guard recordedDisplayID != nil else { return }
        CGDisplayRemoveReconfigurationCallback(displayReconfigurationCallback, Unmanaged.passUnretained(self).toOpaque())
        log.info("Unregistered display reconfiguration callback for displayID=\(self.recordedDisplayID!)")
        recordedDisplayID = nil
    }

    /// Handle a display reconfiguration event dispatched from the C callback.
    ///
    /// Called on the main actor. Checks whether the recorded display was
    /// removed or changed resolution.
    private func handleDisplayReconfiguration(displayID: CGDirectDisplayID, flags: CGDisplayChangeSummaryFlags) {
        guard isRecordingActive, let recordedID = recordedDisplayID else { return }
        guard displayID == recordedID else { return }

        if flags.contains(.removeFlag) {
            log.error("Recorded display \(displayID) was removed during active recording — stopping gracefully")
            // Stop the stream and notify via the error callback
            Task { @MainActor in
                guard self.isRecordingActive else { return }
                self.assetWriter?.cancelWriting()
                if let outputURL = self.assetWriter?.outputURL {
                    try? FileManager.default.removeItem(at: outputURL)
                    log.info("Removed partial recording file: \(outputURL.path, privacy: .public)")
                }
                self.stream = nil
                self.cleanUpWriter()
                self.onStreamError?(.sourceUnavailable("The recorded display was disconnected or removed."))
            }
        } else if flags.contains(.movedFlag) || flags.contains(.setMainFlag) || flags.contains(.setModeFlag) {
            // Resolution or arrangement changed — ScreenCaptureKit handles
            // this internally, so just log for diagnostics.
            log.info("Recorded display \(displayID) reconfigured (flags=\(flags.rawValue)) — continuing recording (ScreenCaptureKit handles resolution changes)")
        }
    }
}

// MARK: - Display Reconfiguration C Callback

/// C-function callback for `CGDisplayRegisterReconfigurationCallback`.
///
/// CoreGraphics invokes this on an arbitrary thread whenever a display is
/// added, removed, or reconfigured. The `userInfo` pointer carries the
/// `ScreenRecorder` instance (passed without retain). We dispatch to the
/// main actor to safely access recorder state.
private func displayReconfigurationCallback(
    displayID: CGDirectDisplayID,
    flags: CGDisplayChangeSummaryFlags,
    userInfo: UnsafeMutableRawPointer?
) {
    // Only process the "after reconfiguration" phase
    guard !flags.contains(.beginConfigurationFlag) else { return }
    guard let userInfo else { return }

    let recorder = Unmanaged<ScreenRecorder>.fromOpaque(userInfo).takeUnretainedValue()
    Task { @MainActor in
        recorder.handleDisplayReconfiguration(displayID: displayID, flags: flags)
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
        let nsError = error as NSError
        log.error("SCStream stopped with error: domain=\(nsError.domain, privacy: .public), code=\(nsError.code), description=\(nsError.localizedDescription, privacy: .public)")
        recorder.handleStreamError(error)
    }
}
