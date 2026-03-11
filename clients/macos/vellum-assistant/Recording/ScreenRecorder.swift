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
    case writerFailed(status: Int, underlyingError: String?)
    case invalidOutputFile

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
        case .writerFailed(let status, let underlyingError):
            if let underlyingError {
                return "Video writer failed (status \(status)): \(underlyingError)"
            }
            return "Video writer finished with non-completed status \(status)"
        case .invalidOutputFile: return "Recording produced an invalid or unplayable file"
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

// MARK: - Writer Context

/// Thread-safe writer context that processes sample buffers on the serial output queue.
///
/// All buffer appends happen directly on the serial output queue — no MainActor
/// dispatch. This preserves FIFO ordering across video, audio, and microphone
/// streams, eliminating the buffer-ordering race that caused AVAssetWriter
/// status 3 (`.failed`) failures when multiple stream types dispatched
/// independently to MainActor via unstructured Tasks.
///
/// ## Thread Safety
///
/// Mutable state (`isActive`, `hasReceivedVideoFrame`, `startTime`,
/// `lastVideoTime`, `hasLoggedFailure`) is guarded by an `NSLock`.
/// Immutable references (`writer`, `videoInput`, `audioInput`, `micInput`)
/// are set at init and safe to read from any thread.
///
/// ## Usage
///
/// - `processSampleBuffer(_:ofType:)` is called directly from `StreamOutputDelegate`
///   on the output queue. It handles writer session start, buffer appending, and
///   first-frame detection.
/// - `markInputsFinished()` must be called on the output queue after all pending
///   buffers have been processed (via `outputQueue.async`).
/// - `deactivate()` is called from MainActor to prevent further buffer processing
///   during cancel or error teardown.
/// - `hasReceivedVideoFrame` is read from MainActor during the frame timeout check.
final class WriterContext: @unchecked Sendable {
    let writer: AVAssetWriter
    let videoInput: AVAssetWriterInput
    let audioInput: AVAssetWriterInput?
    let micInput: AVAssetWriterInput?

    private let lock = NSLock()
    private var _isActive = true
    private var _hasReceivedVideoFrame = false
    private var _startTime: CMTime?
    private var _lastVideoTime: CMTime?
    private var _hasLoggedFailure = false
    private var _bufferCount: Int = 0

    /// File handle for debug logging (writes to recordings/writer-debug.log).
    /// Used because macOS unified logs are often purged/unavailable for diagnosis.
    private let debugLogHandle: FileHandle?

    private static func openDebugLog() -> FileHandle? {
        let appSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        let dir = appSupport.appendingPathComponent("vellum-assistant/recordings", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let logURL = dir.appendingPathComponent("writer-debug.log")
        // Truncate on each new recording session so the file stays small
        FileManager.default.createFile(atPath: logURL.path, contents: nil)
        return FileHandle(forWritingAtPath: logURL.path)
    }

    func debugLog(_ message: String) {
        guard let handle = debugLogHandle else { return }
        let ts = String(format: "%.3f", Date().timeIntervalSince1970)
        let line = "[\(ts)] \(message)\n"
        if let data = line.data(using: .utf8) {
            handle.seekToEndOfFile()
            handle.write(data)
        }
    }

    /// Whether this context is still accepting buffers. Thread-safe.
    var isActive: Bool {
        lock.lock()
        defer { lock.unlock() }
        return _isActive
    }

    /// Whether at least one video frame has been appended. Thread-safe.
    var hasReceivedVideoFrame: Bool {
        lock.lock()
        defer { lock.unlock() }
        return _hasReceivedVideoFrame
    }

    init(writer: AVAssetWriter, videoInput: AVAssetWriterInput, audioInput: AVAssetWriterInput?, micInput: AVAssetWriterInput?) {
        self.writer = writer
        self.videoInput = videoInput
        self.audioInput = audioInput
        self.micInput = micInput
        self.debugLogHandle = Self.openDebugLog()
        debugLog("WriterContext init — output=\(writer.outputURL.lastPathComponent), video=true, audio=\(audioInput != nil), mic=\(micInput != nil)")
    }

    deinit {
        debugLogHandle?.closeFile()
    }

    /// Prevent further buffer processing. Called from MainActor during
    /// cancel or error teardown.
    func deactivate() {
        lock.lock()
        _isActive = false
        lock.unlock()
    }

    /// Process a sample buffer on the output queue. Called directly from
    /// the `SCStreamOutput` delegate — no actor hop.
    ///
    /// Handles writer session start on the first buffer, appends to the
    /// appropriate input, and tracks first-frame receipt for the timeout check.
    func processSampleBuffer(_ sampleBuffer: CMSampleBuffer, ofType type: SCStreamOutputType) {
        let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        guard pts.isValid else { return }

        // Early filter: skip video frames that carry no pixel data.
        // ScreenCaptureKit delivers .idle, .blank, .started, .stopped status
        // frames without an attached pixel buffer. Appending these to the
        // writer causes the H.264 encoder to fail with error -16122.
        // Filter these out BEFORE writer start so we don't initialize the
        // writer session with a data-less buffer.
        if type == .screen, CMSampleBufferGetImageBuffer(sampleBuffer) == nil {
            // Don't increment buffer count for status-only frames
            return
        }

        lock.lock()
        guard _isActive else {
            lock.unlock()
            return
        }
        lock.unlock()

        lock.lock()
        _bufferCount += 1
        let count = _bufferCount
        lock.unlock()

        // Start the writer session on the first buffer that carries data.
        // Video status-only frames (no pixel buffer) are filtered out above,
        // so any buffer reaching this point has actual data to process.
        // Safe to call here because the serial output queue guarantees
        // no concurrent appends or startSession calls.
        if writer.status == .unknown {
            let ok = writer.startWriting()
            debugLog("startWriting() returned \(ok), status=\(writer.status.rawValue), error=\(writer.error?.localizedDescription ?? "none")")
            if ok {
                writer.startSession(atSourceTime: pts)
                lock.lock()
                _startTime = pts
                lock.unlock()
                debugLog("startSession at pts=\(pts.seconds)s, type=\(type.debugLabel)")
            }
            log.info("Writer: startWriting=\(ok) + startSession at pts=\(pts.seconds)s")
        }

        guard writer.status == .writing else {
            // Throttle: log the failure once, not per-buffer at 30fps.
            lock.lock()
            let alreadyLogged = _hasLoggedFailure
            _hasLoggedFailure = true
            lock.unlock()
            if !alreadyLogged {
                let errorDesc = writer.error?.localizedDescription ?? "none"
                let fullError = (writer.error as NSError?)?.description ?? "none"
                debugLog("WRITER FAILED at buffer #\(count): status=\(writer.status.rawValue), error=\(errorDesc), full=\(fullError)")
                log.error("Writer not in writing state: status=\(self.writer.status.rawValue), error=\(self.writer.error?.localizedDescription ?? "none", privacy: .public)")
            }
            return
        }

        switch type {
        case .screen:
            // Status-only frames (no pixel buffer) are already filtered at the
            // top of this method — all video buffers here have valid pixel data.
            if videoInput.isReadyForMoreMediaData {
                // Log pixel format of first few video frames for diagnosis
                if count <= 5, let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) {
                    let pixelFormat = CVPixelBufferGetPixelFormatType(pixelBuffer)
                    let width = CVPixelBufferGetWidth(pixelBuffer)
                    let height = CVPixelBufferGetHeight(pixelBuffer)
                    let fourCC = String(format: "%c%c%c%c",
                        (pixelFormat >> 24) & 0xFF,
                        (pixelFormat >> 16) & 0xFF,
                        (pixelFormat >> 8) & 0xFF,
                        pixelFormat & 0xFF)
                    debugLog("video #\(count): pixelFormat=\(fourCC)(\(pixelFormat)), size=\(width)x\(height), pts=\(pts.seconds)s")
                }
                let ok = videoInput.append(sampleBuffer)
                if !ok {
                    debugLog("VIDEO APPEND FAILED at #\(count), writerStatus=\(writer.status.rawValue), error=\((writer.error as NSError?)?.description ?? "none")")
                }
                lock.lock()
                // Only mark first frame on successful append — a failed append
                // means the encoder is broken and the fallback chain should try
                // the next config rather than declaring startup success.
                if ok {
                    _hasReceivedVideoFrame = true
                }
                _lastVideoTime = pts
                let videoCount = _bufferCount
                lock.unlock()
                // Log every 30th video frame (~1/sec at 30fps) to track progress
                if videoCount % 30 == 0 {
                    debugLog("video frame #\(videoCount) appended, pts=\(pts.seconds)s")
                }
            }
        case .audio:
            if let aInput = audioInput, aInput.isReadyForMoreMediaData {
                // Log format description of first few audio buffers
                if count <= 5 {
                    let fd = CMSampleBufferGetFormatDescription(sampleBuffer)
                    let numSamples = CMSampleBufferGetNumSamples(sampleBuffer)
                    debugLog("audio #\(count): formatDesc=\(fd.map { "\($0)" } ?? "nil"), numSamples=\(numSamples), pts=\(pts.seconds)s")
                }
                let ok = aInput.append(sampleBuffer)
                if !ok {
                    debugLog("AUDIO APPEND FAILED at #\(count), writerStatus=\(writer.status.rawValue), error=\((writer.error as NSError?)?.description ?? "none")")
                }
            }
        case .microphone:
            if let mInput = micInput, mInput.isReadyForMoreMediaData {
                if count <= 5 {
                    let fd = CMSampleBufferGetFormatDescription(sampleBuffer)
                    let numSamples = CMSampleBufferGetNumSamples(sampleBuffer)
                    debugLog("mic #\(count): formatDesc=\(fd.map { "\($0)" } ?? "nil"), numSamples=\(numSamples), pts=\(pts.seconds)s")
                }
                let ok = mInput.append(sampleBuffer)
                if !ok {
                    debugLog("MIC APPEND FAILED at #\(count), writerStatus=\(writer.status.rawValue), error=\((writer.error as NSError?)?.description ?? "none")")
                }
            }
        @unknown default:
            break
        }
    }

    /// Mark all inputs as finished. Must be called on the output queue
    /// after all pending buffers have been processed.
    func markInputsFinished() {
        debugLog("markInputsFinished — total buffers processed: \(_bufferCount)")
        videoInput.markAsFinished()
        audioInput?.markAsFinished()
        micInput?.markAsFinished()
    }
}

private extension SCStreamOutputType {
    var debugLabel: String {
        switch self {
        case .screen: return "screen"
        case .audio: return "audio"
        case .microphone: return "microphone"
        @unknown default: return "unknown(\(rawValue))"
        }
    }
}

/// App-agnostic screen recorder using ScreenCaptureKit + AVAssetWriter.
///
/// Records display or window content to .mov files with H.264 video and
/// optional AAC audio. Stores recordings in the app's Application Support
/// directory under `recordings/`.
///
/// ## Encoder Fallback Chain
///
/// When starting a recording, the encoder tries up to four configurations in
/// order. Each attempt waits 3 seconds for the first video frame before
/// falling through to the next:
///
///   1. **Primary** — H.264 at the source display's native pixel dimensions.
///   2. **Halved** — H.264 at half the source dimensions (2x downscale).
///   3. **HEVC** — HEVC at primary dimensions (only offered when hardware
///      decode is available, used as a proxy for hardware encode support).
///   4. **720p** — H.264 at 1280x720 as a conservative safe fallback.
///
/// If all four fail (writer setup error or no frames within 3s each), the
/// recorder throws `allFallbacksExhausted`.
///
/// ## Dimension Constraints
///
/// All encoder configurations pass through `normalizeDimensions`, which
/// enforces:
///   - **Even dimensions** — H.264/HEVC require macroblock-aligned (even)
///     width and height. Odd values are rounded up.
///   - **Minimum 128px** per axis — the H.264 spec's practical lower bound.
///   - **Maximum 4096px** per axis — real-time encoding limit. Dimensions
///     exceeding this are scaled down proportionally to preserve aspect ratio.
///   - Extreme aspect ratios can push the shorter axis below 128px after
///     downscaling (e.g. 8192x128 → 4096x64), so the minimum is re-applied.
///
/// ## Scale Factor Detection
///
/// `scaleFactor(for:)` determines how many native pixels map to one logical
/// point for a given display:
///   1. Tries `NSScreen.backingScaleFactor` for the matching screen (most
///      reliable — accounts for user-configured scaling).
///   2. Falls back to `CGDisplayPixelsWide / CGDisplayBounds.width` (works
///      when NSScreen is unavailable, e.g. headless or lid-closed setups).
///   3. Defaults to 2x as a last resort.
///
/// ## Display Reconfiguration Monitoring
///
/// During display recordings (not window captures), the recorder registers a
/// `CGDisplayRegisterReconfigurationCallback`. This detects:
///   - **Display removal** (hot-unplug) — cancels the recording, removes the
///     partial file, and notifies via `onStreamError(.sourceUnavailable)`.
///   - **Mode/arrangement changes** — logged for diagnostics but not acted
///     upon, since ScreenCaptureKit handles resolution changes internally.
///
/// The callback is unregistered on stop, cancel, or stream error to avoid
/// dangling references.
///
/// ## Buffer Processing (WriterContext)
///
/// Sample buffers from ScreenCaptureKit are processed directly on the serial
/// output queue via `WriterContext`, with no MainActor dispatch. This preserves
/// FIFO ordering across video/audio/microphone streams and eliminates the
/// buffer-ordering race that previously caused AVAssetWriter failures.
///
/// For the full manual QA validation matrix covering monitor configurations,
/// see `RECORDING_TEST_MATRIX.md` in this directory.
@MainActor
final class ScreenRecorder: NSObject {

    private var stream: SCStream?
    private var writerContext: WriterContext?
    private var recordingStartDate: Date?
    private var isRecordingActive = false
    /// Captures the stream error from `handleStreamError` during startup so
    /// `attemptStartWithConfig` can propagate the typed error (e.g. permission
    /// denied, source unavailable) instead of collapsing it to `.noFramesReceived`.
    private var pendingStreamError: RecorderError?

    /// The display being recorded (nil for window captures). Used by the
    /// display reconfiguration callback to detect removal or resolution changes.
    private var recordedDisplayID: CGDirectDisplayID?

    /// Label of the encode config that was successfully used, for telemetry (M9).
    private(set) var activeConfigLabel: String?

    // MARK: - Telemetry State

    /// Source dimensions before normalization, captured at start for telemetry.
    private var telemetrySourceWidth: Int?
    private var telemetrySourceHeight: Int?
    /// Scale factor used to derive capture dimensions, for telemetry.
    private var telemetryScaleFactor: Double?
    /// Display ID being recorded, for telemetry (nil for window captures).
    private var telemetryDisplayID: UInt32?

    /// Callback invoked when the SCStream stops with an error mid-recording.
    /// RecordingManager sets this to react to stream failures (update state, notify daemon, clean up).
    var onStreamError: ((RecorderError) -> Void)?

    /// When true, incoming sample buffers are silently dropped instead of being
    /// appended to the writer. The SCStream keeps running so resume is instant.
    /// Thread-safe: read on the output queue, written from MainActor.
    nonisolated var isPaused: Bool {
        get { pauseLock.withLock { _isPaused } }
        set { pauseLock.withLock { _isPaused = newValue } }
    }
    private nonisolated(unsafe) var _isPaused = false
    private let pauseLock = NSLock()

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
            telemetrySourceWidth = captureWidth
            telemetrySourceHeight = captureHeight
            telemetryScaleFactor = Double(windowScale)
            telemetryDisplayID = nil
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
            telemetrySourceWidth = captureWidth
            telemetrySourceHeight = captureHeight
            telemetryScaleFactor = Double(displayScale)
            telemetryDisplayID = targetDisplay.displayID
            log.info("Display capture: displayID=\(targetDisplay.displayID), scaleFactor=\(displayScale), sourceSize=\(targetDisplay.width)x\(targetDisplay.height), streamSize=\(captureWidth)x\(captureHeight)")
        }

        do {
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
                    // Register display reconfiguration monitoring now that
                    // startup succeeded. Registering here (instead of before
                    // the fallback loop) prevents handleStreamError from
                    // unregistering it during an earlier failed attempt.
                    if let displayID = telemetryDisplayID {
                        registerDisplayReconfiguration(for: displayID)
                    }
                    let usedFallback = index > 0
                    RecordingTelemetry.logStart(
                        displayID: telemetryDisplayID,
                        sourceWidth: telemetrySourceWidth ?? captureWidth,
                        sourceHeight: telemetrySourceHeight ?? captureHeight,
                        scaleFactor: telemetryScaleFactor ?? 1.0,
                        encodeWidth: encodeConfig.width,
                        encodeHeight: encodeConfig.height,
                        configLabel: encodeConfig.label,
                        usedFallback: usedFallback
                    )
                    log.info("Encoder config '\(encodeConfig.label, privacy: .public)' succeeded")
                    return
                case .writerSetupFailed(let reason):
                    log.warning("Encoder config '\(encodeConfig.label, privacy: .public)' failed: writer setup error — \(reason, privacy: .public)")
                    if isLastConfig {
                        RecordingTelemetry.logError(
                            category: .writer,
                            sourceWidth: telemetrySourceWidth,
                            sourceHeight: telemetrySourceHeight,
                            configLabel: encodeConfig.label,
                            message: "All fallbacks exhausted (last: writer setup — \(reason))"
                        )
                        throw RecorderError.allFallbacksExhausted
                    }
                    let nextLabel = fallbackConfigs[index + 1].label
                    RecordingTelemetry.logFallbackAttempt(fromConfig: encodeConfig.label, toConfig: nextLabel, reason: "writer setup — \(reason)")
                case .noFramesReceived:
                    log.warning("Encoder config '\(encodeConfig.label, privacy: .public)' failed: no frames received within timeout")
                    if isLastConfig {
                        RecordingTelemetry.logError(
                            category: .codec,
                            sourceWidth: telemetrySourceWidth,
                            sourceHeight: telemetrySourceHeight,
                            configLabel: encodeConfig.label,
                            message: "All fallbacks exhausted (last: no frames received)"
                        )
                        throw RecorderError.allFallbacksExhausted
                    }
                    let nextLabel = fallbackConfigs[index + 1].label
                    RecordingTelemetry.logFallbackAttempt(fromConfig: encodeConfig.label, toConfig: nextLabel, reason: "no frames received")
                case .streamStartFailed(let reason):
                    log.warning("Encoder config '\(encodeConfig.label, privacy: .public)' failed: stream start error — \(reason, privacy: .public)")
                    // If the failure came from a typed stream error (permission
                    // denied, source unavailable), throw the original error
                    // immediately — retrying with a different codec won't help.
                    if let typedError = pendingStreamError {
                        pendingStreamError = nil
                        switch typedError {
                        case .permissionDenied, .sourceUnavailable:
                            RecordingTelemetry.logError(
                                category: .stream,
                                sourceWidth: telemetrySourceWidth,
                                sourceHeight: telemetrySourceHeight,
                                configLabel: encodeConfig.label,
                                message: typedError.localizedDescription
                            )
                            throw typedError
                        default:
                            break // transient errors can still try next config
                        }
                    }
                    if isLastConfig {
                        RecordingTelemetry.logError(
                            category: .stream,
                            sourceWidth: telemetrySourceWidth,
                            sourceHeight: telemetrySourceHeight,
                            configLabel: encodeConfig.label,
                            message: "All fallbacks exhausted (last: stream start — \(reason))"
                        )
                        throw RecorderError.allFallbacksExhausted
                    }
                    let nextLabel = fallbackConfigs[index + 1].label
                    RecordingTelemetry.logFallbackAttempt(fromConfig: encodeConfig.label, toConfig: nextLabel, reason: "stream start — \(reason)")
                }
            }

            // Should not reach here — the loop either returns on success or throws on last failure
            throw RecorderError.allFallbacksExhausted
        } catch {
            // If start() fails after registering the display reconfiguration callback,
            // unregister it to avoid a dangling callback referencing this instance.
            unregisterDisplayReconfiguration()
            clearTelemetryState()
            throw error
        }
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
        pendingStreamError = nil

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

        // Each attempt gets a unique output file so failed attempts don't conflict.
        // Use .tmp.mov during recording; stop() atomically renames to .mov after validation.
        let timestamp = ISO8601DateFormatter().string(from: Date()).replacingOccurrences(of: ":", with: "-")
        let outputURL = Self.recordingsDirectory.appendingPathComponent("recording-\(timestamp)-\(UUID().uuidString.prefix(8)).tmp.mov")

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

        // Audio input: AAC (optional — system audio)
        var aInput: AVAssetWriterInput?
        if includeAudio {
            let audioSettings: [String: Any] = [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVSampleRateKey: 48000,
                AVNumberOfChannelsKey: 2,
                AVEncoderBitRateKey: 128000,
            ]
            let input = AVAssetWriterInput(mediaType: .audio, outputSettings: audioSettings)
            input.expectsMediaDataInRealTime = true
            writer.add(input)
            aInput = input
        }

        // Microphone input: AAC (optional — separate track, macOS 15+)
        var mInput: AVAssetWriterInput?
        if includeMicrophone, #available(macOS 15, *) {
            let micSettings: [String: Any] = [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVSampleRateKey: 48000,
                AVNumberOfChannelsKey: 1,
                AVEncoderBitRateKey: 64000,
            ]
            let input = AVAssetWriterInput(mediaType: .audio, outputSettings: micSettings)
            input.expectsMediaDataInRealTime = true
            writer.add(input)
            mInput = input
        }

        // Create the writer context — owns the writer and inputs, processes
        // buffers directly on the serial output queue.
        let ctx = WriterContext(writer: writer, videoInput: vInput, audioInput: aInput, micInput: mInput)
        self.writerContext = ctx

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

        // Create stream and output delegate — the delegate forwards sample
        // buffers directly to WriterContext on the output queue.
        let delegate = StreamOutputDelegate(writerContext: ctx, recorder: self)
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
        recordingStartDate = Date()
        log.info("Screen recording started → \(outputURL.path, privacy: .public)")

        // Wait up to 3 seconds for the first video frame to verify the encoder is working
        let frameTimeoutSeconds = 3.0
        let checkInterval: UInt64 = 100_000_000 // 100ms in nanoseconds
        let maxChecks = Int(frameTimeoutSeconds / 0.1)

        for _ in 0..<maxChecks {
            // Check both frame receipt AND that the recorder hasn't been
            // torn down by handleStreamError running during the sleep yield.
            if ctx.hasReceivedVideoFrame && isRecordingActive {
                return .success
            }
            // If handleStreamError fired and cleaned up, bail out early
            // rather than waiting the full 3s timeout.
            if !isRecordingActive {
                break
            }
            try? await Task.sleep(nanoseconds: checkInterval)
        }

        // Final check after the loop completes — verify both frame receipt
        // and that the recorder wasn't torn down by a concurrent stream error.
        if ctx.hasReceivedVideoFrame && isRecordingActive {
            return .success
        }

        // If handleStreamError fired, it already tore down the writer/stream.
        // Propagate the typed error (e.g. permission denied, source unavailable)
        // instead of collapsing it to the generic .noFramesReceived path.
        if let streamError = pendingStreamError {
            log.warning("Startup attempt failed with stream error for config '\(encodeConfig.label, privacy: .public)': \(streamError.localizedDescription, privacy: .public)")
            // handleStreamError already cleaned up writer/stream/file — just
            // clean up the output file if it wasn't already removed.
            try? FileManager.default.removeItem(at: outputURL)
            // Do NOT clear pendingStreamError here — start() reads it in the
            // .streamStartFailed branch to decide if the error is non-retriable
            // (e.g. permissionDenied, sourceUnavailable). It clears it there.
            return .streamStartFailed(streamError.localizedDescription)
        }

        // No frames arrived — tear down this attempt
        log.warning("No video frames received after \(frameTimeoutSeconds)s for config '\(encodeConfig.label, privacy: .public)' — tearing down")
        if let s = stream {
            try? await s.stopCapture()
        }
        stream = nil
        ctx.deactivate()
        // Drain the output queue before cancelling to avoid concurrent writer access.
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            outputQueue.async { continuation.resume() }
        }
        ctx.writer.cancelWriting()
        try? FileManager.default.removeItem(at: outputURL)
        cleanUpWriter()

        return .noFramesReceived
    }

    // MARK: - Stop Recording

    /// Stop the active recording and return the result.
    ///
    /// - Returns: `RecordingResult` with the file path and duration.
    func stop() async throws -> RecordingResult {
        guard isRecordingActive, let ctx = writerContext else {
            throw RecorderError.notRecording
        }

        // Gate early: prevent new sample buffers from being processed.
        isRecordingActive = false

        // Unregister display monitoring early to avoid the reconfiguration
        // callback racing with teardown.
        unregisterDisplayReconfiguration()

        // Stop the capture stream — after this returns, no new buffers
        // will be enqueued on the output queue.
        if let stream {
            try? await stream.stopCapture()
        }
        stream = nil

        // Deterministic drain: enqueue a block on the output queue that
        // runs AFTER all pending buffer-processing blocks. This guarantees
        // every in-flight buffer is appended before we mark inputs as
        // finished — no fragile Task.yield() needed.
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            outputQueue.async {
                ctx.markInputsFinished()
                continuation.resume()
            }
        }

        guard ctx.hasReceivedVideoFrame else {
            log.error("Stop: no video frames captured — discarding recording")
            RecordingTelemetry.logError(
                category: .codec,
                sourceWidth: telemetrySourceWidth,
                sourceHeight: telemetrySourceHeight,
                configLabel: activeConfigLabel,
                message: "No video frames captured during recording"
            )
            if let outputURL = ctx.writer.outputURL as URL? {
                try? FileManager.default.removeItem(at: outputURL)
            }
            cleanUpWriter()
            clearTelemetryState()
            throw RecorderError.noFramesCaptured
        }

        let writer = ctx.writer
        let outputURL = writer.outputURL

        // Finish writing
        log.info("Stop: inputs marked finished (video=true, audio=\(ctx.audioInput != nil), mic=\(ctx.micInput != nil))")

        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            writer.finishWriting {
                continuation.resume()
            }
        }

        let writerStatus = writer.status
        if writerStatus == .completed {
            ctx.debugLog("finishWriting completed successfully")
            log.info("Writer: finishWriting completed successfully")
        } else {
            let errorDesc = writer.error?.localizedDescription ?? "none"
            let fullError = (writer.error as NSError?)?.description ?? "none"
            ctx.debugLog("FINISH FAILED: status=\(writerStatus.rawValue), error=\(errorDesc), full=\(fullError)")
            log.error("Writer: finishWriting ended with status=\(writerStatus.rawValue), error=\(writer.error?.localizedDescription ?? "none", privacy: .public)")
            // Writer did not complete successfully — the output file is likely corrupt.
            // Clean up and throw so RecordingManager sends status: "failed".
            try? FileManager.default.removeItem(at: outputURL)
            let durationMs: Int
            if let startDate = recordingStartDate {
                durationMs = Int(Date().timeIntervalSince(startDate) * 1000)
            } else {
                durationMs = 0
            }
            let fileSize = 0
            RecordingTelemetry.logStop(durationMs: durationMs, fileSize: fileSize, status: .error)
            cleanUpWriter()
            clearTelemetryState()
            throw RecorderError.writerFailed(status: Int(writerStatus.rawValue), underlyingError: writer.error?.localizedDescription)
        }

        // Playability integrity gate + atomic file publication.
        // Both asset.load(.duration) and moveItem can throw — ensure
        // cleanup (file removal, writer/telemetry reset) always runs
        // on error so we don't leak .tmp.mov files or stale state.
        let finalURL: URL
        do {
            let asset = AVURLAsset(url: outputURL)
            let duration = try await asset.load(.duration)
            guard duration.seconds > 0 else {
                log.error("Stop: output file has zero or negative duration — discarding as invalid")
                try? FileManager.default.removeItem(at: outputURL)
                cleanUpWriter()
                clearTelemetryState()
                throw RecorderError.invalidOutputFile
            }

            // Atomic file publication: rename from .tmp.mov to .mov now that the
            // file is validated. Clients observing the recordings directory will
            // only see the final file after it is complete and playable.
            let dest = outputURL.deletingPathExtension().deletingPathExtension()
                .appendingPathExtension("mov")
            try FileManager.default.moveItem(at: outputURL, to: dest)
            log.info("Atomically renamed recording: \(outputURL.lastPathComponent, privacy: .public) → \(dest.lastPathComponent, privacy: .public)")
            finalURL = dest
        } catch let error as RecorderError {
            // RecorderError.invalidOutputFile already cleaned up above — rethrow as-is.
            throw error
        } catch {
            log.error("Stop: post-write validation/rename failed — \(error.localizedDescription, privacy: .public)")
            try? FileManager.default.removeItem(at: outputURL)
            cleanUpWriter()
            clearTelemetryState()
            throw RecorderError.invalidOutputFile
        }

        let durationMs: Int
        if let startDate = recordingStartDate {
            durationMs = Int(Date().timeIntervalSince(startDate) * 1000)
        } else {
            durationMs = 0
        }

        // Verify the output file exists and has non-zero size before
        // reporting success. A zero-length file indicates a silent write
        // failure that the writer status check above may not catch.
        guard FileManager.default.fileExists(atPath: finalURL.path) else {
            log.error("Stop: output file missing after finalization — \(finalURL.path, privacy: .public)")
            cleanUpWriter()
            clearTelemetryState()
            throw RecorderError.invalidOutputFile
        }

        let fileSize = (try? FileManager.default.attributesOfItem(atPath: finalURL.path)[.size] as? Int) ?? 0

        guard fileSize > 0 else {
            log.error("Stop: output file is zero-length — discarding as invalid")
            try? FileManager.default.removeItem(at: finalURL)
            cleanUpWriter()
            clearTelemetryState()
            throw RecorderError.invalidOutputFile
        }

        RecordingTelemetry.logStop(durationMs: durationMs, fileSize: fileSize, status: .success)

        cleanUpWriter()
        clearTelemetryState()
        log.info("Recording complete — duration=\(durationMs)ms, fileSize=\(fileSize) bytes, file=\(finalURL.path, privacy: .public)")

        return RecordingResult(filePath: finalURL.path, durationMs: durationMs)
    }

    /// Cancel the active recording synchronously, discarding the output file.
    ///
    /// Uses `AVAssetWriter.cancelWriting()` which is synchronous and safe to
    /// call during `applicationWillTerminate` where async work cannot complete.
    func cancelRecording() {
        guard isRecordingActive else { return }

        // Reset pause flag so it doesn't leak into a future recording.
        isPaused = false

        // Emit cancel telemetry before tearing down state
        let durationMs: Int
        if let startDate = recordingStartDate {
            durationMs = Int(Date().timeIntervalSince(startDate) * 1000)
        } else {
            durationMs = 0
        }
        RecordingTelemetry.logStop(durationMs: durationMs, fileSize: 0, status: .cancel)

        // Unregister display monitoring since the recording session is ending.
        unregisterDisplayReconfiguration()

        // Stop the stream synchronously (best-effort — stopCapture is async but
        // we nil it out so no more buffers arrive).
        stream = nil

        // Deactivate the writer context to prevent any remaining buffers on the
        // output queue from being appended, then drain the queue before cancelling.
        // The sync drain ensures no concurrent writer access (a buffer that already
        // passed the _isActive check finishes before cancelWriting runs).
        writerContext?.deactivate()
        outputQueue.sync {}
        writerContext?.writer.cancelWriting()

        // Remove the partial file to avoid leaving corrupted output
        if let outputURL = writerContext?.writer.outputURL {
            try? FileManager.default.removeItem(at: outputURL)
            log.info("Cancelled recording — removed partial file \(outputURL.path, privacy: .public)")
        }

        cleanUpWriter()
        clearTelemetryState()
    }

    // MARK: - Stream Error Handling

    /// Map an NSError from SCStream to a specific RecorderError case.
    nonisolated static func mapStreamError(_ nsError: NSError) -> RecorderError {
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

            log.error("Stream error during active recording — cleaning up (error=\(recorderError.localizedDescription, privacy: .public))")

            // Reset pause flag so it doesn't leak into a future recording.
            self.isPaused = false

            // Store for attemptStartWithConfig to propagate typed errors
            // instead of collapsing them to .noFramesReceived.
            pendingStreamError = recorderError

            RecordingTelemetry.logError(
                category: RecordingTelemetry.categorize(recorderError),
                sourceWidth: telemetrySourceWidth,
                sourceHeight: telemetrySourceHeight,
                configLabel: activeConfigLabel,
                message: recorderError.localizedDescription
            )

            // Unregister display monitoring since the recording session is ending.
            unregisterDisplayReconfiguration()

            // Deactivate the writer context, then drain the output queue before
            // cancelling to avoid concurrent writer access with in-flight appends.
            writerContext?.deactivate()
            await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                self.outputQueue.async { continuation.resume() }
            }
            writerContext?.writer.cancelWriting()
            if let outputURL = writerContext?.writer.outputURL {
                try? FileManager.default.removeItem(at: outputURL)
                log.info("Removed partial recording file: \(outputURL.path, privacy: .public)")
            }

            stream = nil
            cleanUpWriter()
            clearTelemetryState()

            onStreamError?(recorderError)
        }
    }

    private func cleanUpWriter() {
        isRecordingActive = false
        writerContext = nil
        recordingStartDate = nil
        outputDelegate = nil
        activeConfigLabel = nil
    }

    /// Reset telemetry state. Called separately from cleanUpWriter because
    /// telemetry state must persist across fallback attempts within a single
    /// start() call, but should be cleared when the recording fully ends.
    private func clearTelemetryState() {
        telemetrySourceWidth = nil
        telemetrySourceHeight = nil
        telemetryScaleFactor = nil
        telemetryDisplayID = nil
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
    fileprivate func handleDisplayReconfiguration(displayID: CGDirectDisplayID, flags: CGDisplayChangeSummaryFlags) {
        guard isRecordingActive, let recordedID = recordedDisplayID else { return }
        guard displayID == recordedID else { return }

        if flags.contains(.removeFlag) {
            log.error("Recorded display \(displayID) was removed during active recording — stopping gracefully")
            // Stop the stream and notify via the error callback
            Task { @MainActor in
                guard self.isRecordingActive else { return }

                // Log telemetry before tearing down state so source dimensions
                // and config label are still available.
                RecordingTelemetry.logError(
                    category: .source,
                    sourceWidth: self.telemetrySourceWidth,
                    sourceHeight: self.telemetrySourceHeight,
                    configLabel: self.activeConfigLabel,
                    message: "Recorded display \(displayID) was disconnected or removed during active recording"
                )

                // Unregister display monitoring since the recording session is ending.
                self.unregisterDisplayReconfiguration()
                self.writerContext?.deactivate()
                await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                    self.outputQueue.async { continuation.resume() }
                }
                self.writerContext?.writer.cancelWriting()
                if let outputURL = self.writerContext?.writer.outputURL {
                    try? FileManager.default.removeItem(at: outputURL)
                    log.info("Removed partial recording file: \(outputURL.path, privacy: .public)")
                }
                self.stream = nil
                self.cleanUpWriter()
                self.clearTelemetryState()
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

/// Receives sample buffers from SCStream on the serial output queue and
/// forwards them directly to `WriterContext` for processing — no MainActor
/// dispatch. This preserves FIFO ordering and eliminates buffer-ordering races.
private final class StreamOutputDelegate: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    private let writerContext: WriterContext
    private let recorder: ScreenRecorder

    init(writerContext: WriterContext, recorder: ScreenRecorder) {
        self.writerContext = writerContext
        self.recorder = recorder
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        // Drop frames while paused — the stream keeps running so resume is instant
        guard !recorder.isPaused else { return }
        writerContext.processSampleBuffer(sampleBuffer, ofType: type)
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        let nsError = error as NSError
        log.error("SCStream stopped with error: domain=\(nsError.domain, privacy: .public), code=\(nsError.code), description=\(nsError.localizedDescription, privacy: .public)")
        recorder.handleStreamError(error)
    }
}
