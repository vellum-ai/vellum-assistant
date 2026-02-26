import Foundation
import os

/// Structured telemetry for the screen recording subsystem.
///
/// Emits key metrics at recording start, stop, and on errors via os.Logger
/// so that monitor-specific regressions can be caught quickly after rollout.
/// All data stays local — no external analytics SDKs.
enum RecordingTelemetry {

    private static let log = Logger(
        subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant",
        category: "RecordingTelemetry"
    )

    // MARK: - Error Categories

    /// Coarse error category for telemetry grouping.
    enum ErrorCategory: String {
        case dimension
        case codec
        case permission
        case stream
        case writer
        case source
        case unknown
    }

    /// Classify a RecorderError into a telemetry-friendly category.
    static func categorize(_ error: RecorderError) -> ErrorCategory {
        switch error {
        case .unsupportedDimensions:
            return .dimension
        case .allFallbacksExhausted:
            return .codec
        case .permissionDenied:
            return .permission
        case .streamStartFailed, .sessionInterrupted:
            return .stream
        case .writerSetupFailed, .writerFailed:
            return .writer
        case .noMatchingDisplay, .noMatchingWindow, .sourceUnavailable:
            return .source
        case .invalidOutputFile:
            return .writer
        case .notRecording, .noFramesCaptured:
            return .unknown
        }
    }

    // MARK: - Start Telemetry

    /// Log structured telemetry when a recording starts successfully.
    ///
    /// - Parameters:
    ///   - displayID: The CGDirectDisplayID of the target display (nil for window captures).
    ///   - sourceWidth: Raw width from ScreenCaptureKit before normalization.
    ///   - sourceHeight: Raw height from ScreenCaptureKit before normalization.
    ///   - scaleFactor: The backing scale factor used for dimension calculation.
    ///   - encodeWidth: Final encode width after normalization.
    ///   - encodeHeight: Final encode height after normalization.
    ///   - configLabel: The encoder config label that succeeded (e.g. "primary", "fallback-half").
    ///   - usedFallback: Whether a non-primary config was used.
    static func logStart(
        displayID: UInt32?,
        sourceWidth: Int,
        sourceHeight: Int,
        scaleFactor: Double,
        encodeWidth: Int,
        encodeHeight: Int,
        configLabel: String,
        usedFallback: Bool
    ) {
        log.info("""
            recording.start: \
            displayID=\(displayID.map { String($0) } ?? "window", privacy: .public), \
            sourceSize=\(sourceWidth)x\(sourceHeight), \
            scaleFactor=\(String(format: "%.1f", scaleFactor), privacy: .public), \
            encodeSize=\(encodeWidth)x\(encodeHeight), \
            config=\(configLabel, privacy: .public), \
            usedFallback=\(usedFallback)
            """)
    }

    // MARK: - Stop Telemetry

    /// Terminal status of a completed recording.
    enum TerminalStatus: String {
        case success
        case error
        case cancel
    }

    /// Log structured telemetry when a recording stops.
    ///
    /// - Parameters:
    ///   - durationMs: Total recording duration in milliseconds.
    ///   - fileSize: Final file size in bytes.
    ///   - status: Terminal status (success, error, or cancel).
    static func logStop(
        durationMs: Int,
        fileSize: Int,
        status: TerminalStatus
    ) {
        log.info("""
            recording.stop: \
            durationMs=\(durationMs), \
            fileSize=\(fileSize), \
            status=\(status.rawValue, privacy: .public)
            """)
    }

    // MARK: - Error Telemetry

    /// Log structured telemetry when a recording error occurs.
    ///
    /// - Parameters:
    ///   - category: Coarse error classification for grouping.
    ///   - sourceWidth: Source dimensions at the time of failure (if available).
    ///   - sourceHeight: Source dimensions at the time of failure (if available).
    ///   - configLabel: The fallback config that was active when the error occurred (if any).
    ///   - message: Human-readable error description.
    static func logError(
        category: ErrorCategory,
        sourceWidth: Int?,
        sourceHeight: Int?,
        configLabel: String?,
        message: String
    ) {
        let dims: String
        if let w = sourceWidth, let h = sourceHeight {
            dims = "\(w)x\(h)"
        } else {
            dims = "unknown"
        }

        log.error("""
            recording.error: \
            category=\(category.rawValue, privacy: .public), \
            sourceDimensions=\(dims, privacy: .public), \
            config=\(configLabel ?? "none", privacy: .public), \
            message=\(message, privacy: .public)
            """)
    }

    // MARK: - Fallback Attempt Telemetry

    /// Log when a fallback config is being attempted after a previous config failed.
    ///
    /// - Parameters:
    ///   - fromConfig: The config label that failed.
    ///   - toConfig: The config label being tried next.
    ///   - reason: Why the previous config failed.
    static func logFallbackAttempt(
        fromConfig: String,
        toConfig: String,
        reason: String
    ) {
        log.info("""
            recording.fallback: \
            from=\(fromConfig, privacy: .public), \
            to=\(toConfig, privacy: .public), \
            reason=\(reason, privacy: .public)
            """)
    }
}
