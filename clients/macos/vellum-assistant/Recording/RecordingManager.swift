import Foundation
import VellumAssistantShared
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "RecordingManager")

/// The type of owner that initiated a recording.
enum RecordingOwner: Equatable, Sendable {
    /// Standalone recording triggered via the daemon's recording_start message.
    case standalone
}

/// State machine for the recording lifecycle.
enum RecordingState: Equatable, Sendable {
    case idle
    case starting
    case recording
    case paused
    case stopping
    case restarting
    case failed(String)

    var isActive: Bool {
        switch self {
        case .starting, .recording, .paused, .stopping, .restarting: return true
        case .idle, .failed: return false
        }
    }
}

/// Centralized recording orchestration ensuring at most one active recording.
///
/// Manages the recording lifecycle (start/stop), enforces the single-active
/// guard, and sends `RecordingStatus` messages back to the daemon.
@MainActor
final class RecordingManager: ObservableObject {

    // MARK: - Published State

    @Published private(set) var state: RecordingState = .idle
    @Published private(set) var ownerSessionId: String?
    @Published private(set) var attachToConversationId: String?

    /// Operation token for restart race hardening. When set, status messages
    /// include this token so the daemon can reject stale completions.
    private(set) var operationToken: String?

    // MARK: - Dependencies

    private let recorder = ScreenRecorder()
    private weak var daemonClient: DaemonClient?

    /// Callback invoked when source validation fails with `.noMatchingDisplay`
    /// or `.noMatchingWindow` and `promptForSource` was set. The caller
    /// (AppDelegate) can use this to re-show the source picker.
    var onSourceValidationFailed: ((_ sessionId: String, _ attachToConversationId: String?) -> Void)?

    init(daemonClient: DaemonClient? = nil) {
        self.daemonClient = daemonClient
    }

    // MARK: - Start

    /// Start a new recording.
    ///
    /// This method is async — it awaits the actual recorder start and only
    /// returns `true` after the recording has been confirmed. Callers should
    /// await the result before showing UI (e.g., the recording HUD).
    ///
    /// - Parameters:
    ///   - sessionId: The recording session ID (matches `recordingId` from `RecordingStart`).
    ///   - options: Recording options (capture scope, display/window, audio).
    ///   - attachToConversationId: Optional conversation ID to attach the recording to.
    /// - Returns: `true` if the recording started successfully, `false` otherwise.
    @discardableResult
    func start(sessionId: String, options: IPCRecordingOptions? = nil, attachToConversationId: String? = nil, promptForSource: Bool = false, operationToken: String? = nil) async -> Bool {
        guard !state.isActive else {
            log.warning("Cannot start recording — already active (state=\(String(describing: self.state)), owner=\(self.ownerSessionId ?? "nil"))")
            sendStatus(sessionId: sessionId, status: "failed", error: "Another recording is already active")
            return false
        }

        self.ownerSessionId = sessionId
        self.attachToConversationId = attachToConversationId
        self.operationToken = operationToken
        self.state = .starting

        // Reset pause flag so a stale isPaused from a previous session
        // (e.g. error-during-pause) doesn't silently drop every frame.
        recorder.isPaused = false

        // Clear any stale stream error callback from a previous session.
        // If the prior recording ended via stream error, the old callback
        // (capturing the old sessionId) is never cleared. Without this,
        // a stream error during this session's startup fallback chain could
        // fire the stale callback, sending a failure status for the wrong
        // session and corrupting this session's state.
        recorder.onStreamError = nil

        do {
            try await recorder.start(
                captureScope: options?.captureScope ?? "display",
                displayId: options?.displayId,
                windowId: options?.windowId.flatMap { Int(exactly: $0) },
                includeAudio: options?.includeAudio ?? false,
                includeMicrophone: options?.includeMicrophone ?? false
            )

            // Guard against stale completion: if stop() or forceStop() was called
            // while we were awaiting recorder.start(), don't override the state.
            guard state == .starting, ownerSessionId == sessionId else {
                log.info("Recording start completed but state changed during await — checking ownership before cancelling (state=\(String(describing: self.state)), owner=\(self.ownerSessionId ?? "nil"))")
                // Only cancel if no other session has taken ownership of the recorder.
                // If ownerSessionId points to a different session and the state is active,
                // that session now owns the recorder — cancelling would tear down its recording.
                if ownerSessionId == nil || !state.isActive {
                    recorder.cancelRecording()
                }
                return false
            }

            state = .recording

            // Wire up the stream error callback AFTER startup is confirmed.
            // During startup, ScreenRecorder.attemptStartWithConfig() handles stream
            // errors internally as part of the fallback chain. Installing the callback
            // earlier would let a transient didStopWithError from an early fallback
            // config flip the manager out of .starting state, causing the stale-completion
            // guard above to cancel a recording that actually succeeded on a later config.
            recorder.onStreamError = { [weak self] recorderError in
                guard let self else { return }
                let message = recorderError.localizedDescription
                log.error("Stream error during recording session \(sessionId, privacy: .public): \(message, privacy: .public)")

                self.state = .failed(message)
                self.sendStatus(sessionId: sessionId, status: "failed", error: message)
                self.ownerSessionId = nil
                self.attachToConversationId = nil
            }

            sendStatus(sessionId: sessionId, status: "started")
            log.info("Recording started for session \(sessionId, privacy: .public)")
            return true
        } catch {
            // Only update state if we're still the active start attempt
            if state == .starting, ownerSessionId == sessionId {
                // If source validation failed and promptForSource was set,
                // re-show the source picker instead of failing permanently.
                let isSourceValidationError: Bool
                if let recorderError = error as? RecorderError {
                    switch recorderError {
                    case .noMatchingDisplay, .noMatchingWindow:
                        isSourceValidationError = true
                    default:
                        isSourceValidationError = false
                    }
                } else {
                    isSourceValidationError = false
                }

                if isSourceValidationError && promptForSource {
                    log.warning("Source validation failed with promptForSource — re-showing source picker for session \(sessionId, privacy: .public)")
                    state = .idle
                    ownerSessionId = nil
                    onSourceValidationFailed?(sessionId, attachToConversationId)
                    self.attachToConversationId = nil
                    return false
                }

                let message = error.localizedDescription
                state = .failed(message)
                sendStatus(sessionId: sessionId, status: "failed", error: message)
                log.error("Recording failed to start: \(message, privacy: .public)")
                // Note: telemetry logging is handled inside ScreenRecorder.start()
                // with richer context (source dimensions, config labels). Logging
                // here again would double-report with lower-fidelity data.
            }
            return false
        }
    }

    // MARK: - Stop

    /// Stop the active recording.
    ///
    /// - Parameter sessionId: The recording session ID. Must match the active recording.
    /// - Returns: Tuple of (filePath, durationMs) on success, or `nil` if not recording.
    func stop(sessionId: String) async -> (filePath: String, durationMs: Int)? {
        guard state.isActive, ownerSessionId == sessionId else {
            log.warning("Cannot stop recording — no active recording for session \(sessionId, privacy: .public)")
            return nil
        }

        // If paused, unpause so the writer can finalize cleanly
        if state == .paused {
            recorder.isPaused = false
        }

        state = .stopping

        do {
            let result = try await recorder.stop()
            recorder.onStreamError = nil
            state = .idle
            sendStatus(
                sessionId: sessionId,
                status: "stopped",
                filePath: result.filePath,
                durationMs: result.durationMs
            )
            log.info("Recording stopped for session \(sessionId, privacy: .public) — \(result.durationMs)ms")

            let savedSessionId = ownerSessionId
            let savedConversationId = attachToConversationId
            ownerSessionId = nil
            attachToConversationId = nil
            operationToken = nil

            _ = savedSessionId
            _ = savedConversationId

            return (result.filePath, result.durationMs)
        } catch {
            recorder.onStreamError = nil
            let message = error.localizedDescription
            state = .failed(message)
            sendStatus(sessionId: sessionId, status: "failed", error: message)
            log.error("Recording stop failed: \(message, privacy: .public)")
            return nil
        }
    }

    // MARK: - Pause

    /// Pause the active recording.
    ///
    /// Only valid when the state is `.recording`. The underlying ScreenRecorder
    /// stream keeps running but frames are dropped, so the output file won't
    /// contain the paused interval.
    ///
    /// - Parameter sessionId: The recording session ID. Must match the active recording.
    /// - Returns: `true` if the recording was paused, `false` if not in a pausable state.
    @discardableResult
    func pause(sessionId: String) -> Bool {
        guard state == .recording, ownerSessionId == sessionId else {
            log.warning("Cannot pause recording — not recording (state=\(String(describing: self.state)), owner=\(self.ownerSessionId ?? "nil"), requested=\(sessionId, privacy: .public))")
            return false
        }

        recorder.isPaused = true
        state = .paused
        sendStatus(sessionId: sessionId, status: "paused")
        log.info("Recording paused for session \(sessionId, privacy: .public)")
        return true
    }

    // MARK: - Resume

    /// Resume a paused recording.
    ///
    /// Only valid when the state is `.paused`. Resumes writing frames from
    /// the ScreenRecorder stream.
    ///
    /// - Parameter sessionId: The recording session ID. Must match the active recording.
    /// - Returns: `true` if the recording was resumed, `false` if not in a resumable state.
    @discardableResult
    func resume(sessionId: String) -> Bool {
        guard state == .paused, ownerSessionId == sessionId else {
            log.warning("Cannot resume recording — not paused (state=\(String(describing: self.state)), owner=\(self.ownerSessionId ?? "nil"), requested=\(sessionId, privacy: .public))")
            return false
        }

        recorder.isPaused = false
        state = .recording
        sendStatus(sessionId: sessionId, status: "resumed")
        log.info("Recording resumed for session \(sessionId, privacy: .public)")
        return true
    }

    // MARK: - Force Stop

    /// Force-stop any active recording, regardless of owner. Used during app shutdown.
    ///
    /// This method is synchronous and safe to call from `applicationWillTerminate`
    /// where async work cannot complete before the process exits.
    /// It discards the recording rather than trying to finalize the file.
    func forceStop() {
        guard state.isActive else { return }

        // Unpause before cancelling so internal state is consistent
        if state == .paused {
            recorder.isPaused = false
        }

        recorder.onStreamError = nil
        recorder.cancelRecording()

        let sessionId = ownerSessionId
        if let sessionId {
            sendStatus(sessionId: sessionId, status: "failed", error: "Recording cancelled during shutdown")
        }

        state = .idle
        ownerSessionId = nil
        attachToConversationId = nil
        operationToken = nil
        log.info("Force-stopped recording (synchronous cancel)")
    }

    // MARK: - Daemon Communication

    private func sendStatus(
        sessionId: String,
        status: String,
        filePath: String? = nil,
        durationMs: Int? = nil,
        error: String? = nil
    ) {
        guard let client = daemonClient else {
            log.warning("No daemon client — cannot send recording status")
            return
        }

        let message = IPCRecordingStatus(
            type: "recording_status",
            sessionId: sessionId,
            status: status,
            filePath: filePath,
            durationMs: durationMs.flatMap { Double($0) },
            error: error,
            attachToConversationId: attachToConversationId,
            operationToken: operationToken
        )

        do {
            try client.send(message)
        } catch {
            log.error("Failed to send recording status: \(error.localizedDescription)")
        }
    }
}
