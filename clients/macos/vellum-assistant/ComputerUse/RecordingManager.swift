import Foundation
import VellumAssistantShared
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "RecordingManager")

/// Centralized owner of `ScreenRecorder`. Both CU sessions and standalone skill-based
/// recordings go through this manager, ensuring at most one recording is active globally.
@MainActor
final class RecordingManager: ObservableObject {

    // MARK: - Types

    enum OwnerType: Equatable, CustomStringConvertible {
        case cu
        case skill

        var description: String {
            switch self {
            case .cu: return "cu"
            case .skill: return "skill"
            }
        }
    }

    enum State: Equatable {
        case idle
        case starting
        case recording
        case stopping
        case failed(String)
    }

    // MARK: - Published State

    @Published private(set) var state: State = .idle

    // MARK: - Owner Tracking

    private(set) var ownerType: OwnerType?
    private(set) var ownerSessionId: String?

    // MARK: - Dependencies

    private var screenRecorder: ScreenRecorder?
    private let daemonClient: DaemonClientProtocol
    private var attachToConversationId: String?

    // MARK: - Convenience

    var isRecording: Bool { state == .recording }
    var isActive: Bool {
        switch state {
        case .idle, .failed: return false
        case .starting, .recording, .stopping: return true
        }
    }

    // MARK: - Init

    init(daemonClient: DaemonClientProtocol) {
        self.daemonClient = daemonClient
    }

    // MARK: - Start

    /// Start a new recording.
    /// - Returns: `true` if recording started (or is starting), `false` if already active with a different owner.
    @discardableResult
    func start(
        owner: OwnerType,
        sessionId: String,
        options: IPCRecordingOptions?,
        attachToConversationId: String?
    ) async throws -> Bool {
        // Already active — check ownership
        if isActive {
            if ownerSessionId == sessionId && ownerType == owner {
                log.info("start() called for same owner — ignoring (state=\(String(describing: self.state)))")
                return true
            }
            log.warning("start() rejected — already active for \(self.ownerType?.description ?? "nil"):\(self.ownerSessionId ?? "nil")")
            return false
        }

        // Claim ownership
        ownerType = owner
        ownerSessionId = sessionId
        self.attachToConversationId = attachToConversationId
        state = .starting

        let recorder = ScreenRecorder()
        self.screenRecorder = recorder

        do {
            try await recorder.start(
                captureScope: options?.captureScope,
                displayId: options?.displayId,
                windowId: options?.windowId,
                includeAudio: options?.includeAudio ?? false
            )
            state = .recording
            sendRecordingStatus(status: "started", sessionId: sessionId)
            log.info("Recording started for \(owner):\(sessionId)")
            return true
        } catch {
            let reason = error.localizedDescription
            state = .failed(reason)
            sendRecordingStatus(status: "failed", sessionId: sessionId, error: reason)
            log.error("Recording failed to start: \(reason)")
            // Clean up
            screenRecorder = nil
            ownerType = nil
            ownerSessionId = nil
            self.attachToConversationId = nil
            throw error
        }
    }

    // MARK: - Stop

    /// Stop the active recording. Only the same owner (by sessionId) can stop it.
    /// - Returns: Tuple of (filePath, durationMs) if recording was stopped successfully.
    func stop(sessionId: String) async throws -> (filePath: String?, durationMs: Double?) {
        guard isActive, ownerSessionId == sessionId else {
            log.warning("stop() rejected — not active or wrong owner (active=\(self.ownerSessionId ?? "nil"), requested=\(sessionId))")
            return (nil, nil)
        }
        return try await performStop(sessionId: sessionId)
    }

    /// Force stop regardless of owner — used for app shutdown.
    func forceStop() async {
        guard isActive else { return }
        let sid = ownerSessionId ?? "unknown"
        log.info("Force stopping recording for \(self.ownerType?.description ?? "nil"):\(sid)")
        do {
            _ = try await performStop(sessionId: sid)
        } catch {
            log.error("Force stop failed: \(error.localizedDescription)")
            resetState()
        }
    }

    // MARK: - Recording Gate

    /// Wait for the recording to reach `.recording` state, polling every 100ms.
    /// Returns `true` if recording started, `false` if timeout (5s) expired or recording failed.
    func waitForRecordingReady() async -> Bool {
        if state == .recording { return true }

        let timeoutMs: UInt64 = 5_000
        let pollMs: UInt64 = 100
        var elapsed: UInt64 = 0

        log.info("Recording gate: waiting for recording to start (timeout: \(timeoutMs)ms)")

        while elapsed < timeoutMs {
            try? await Task.sleep(nanoseconds: pollMs * 1_000_000)
            elapsed += pollMs

            switch state {
            case .recording:
                log.info("Recording gate: recording started after \(elapsed)ms")
                return true
            case .failed(let reason):
                log.error("Recording gate: recording failed — \(reason)")
                return false
            case .idle:
                log.warning("Recording gate: recording went idle unexpectedly")
                return false
            case .starting:
                continue
            case .stopping:
                log.warning("Recording gate: recording is stopping unexpectedly")
                return false
            }
        }

        log.error("Recording gate: timed out after \(elapsed)ms")
        return false
    }

    // MARK: - Private

    private func performStop(sessionId: String) async throws -> (filePath: String?, durationMs: Double?) {
        state = .stopping

        guard let recorder = screenRecorder, recorder.isRecording else {
            log.warning("performStop called but no active recorder")
            sendRecordingStatus(status: "stopped", sessionId: sessionId)
            resetState()
            return (nil, nil)
        }

        do {
            let result = try await recorder.stop()
            sendRecordingStatus(
                status: "stopped",
                sessionId: sessionId,
                filePath: result.filePath,
                durationMs: result.durationMs
            )
            log.info("Recording stopped — file: \(result.filePath), duration: \(result.durationMs)ms")
            resetState()
            return (result.filePath, result.durationMs)
        } catch {
            let reason = error.localizedDescription
            log.error("Failed to stop recording: \(reason)")
            sendRecordingStatus(status: "failed", sessionId: sessionId, error: reason)
            state = .failed(reason)
            screenRecorder = nil
            ownerType = nil
            ownerSessionId = nil
            attachToConversationId = nil
            throw error
        }
    }

    private func resetState() {
        screenRecorder = nil
        ownerType = nil
        ownerSessionId = nil
        attachToConversationId = nil
        state = .idle
    }

    private func sendRecordingStatus(
        status: String,
        sessionId: String,
        filePath: String? = nil,
        durationMs: Double? = nil,
        error: String? = nil
    ) {
        do {
            try daemonClient.send(RecordingStatusMessage(
                sessionId: sessionId,
                status: status,
                filePath: filePath,
                durationMs: durationMs,
                error: error,
                attachToConversationId: attachToConversationId
            ))
        } catch {
            log.error("Failed to send recording status '\(status)': \(error)")
        }
    }
}
