import Combine
import Foundation
import os

private let log = Logger(subsystem: "com.vellum.vellum-assistant", category: "LiveTranscriptManager")

/// A timestamped segment of transcribed text from system audio.
struct TranscriptSegment: Identifiable {
    let id = UUID()
    let text: String
    let timestamp: Date
    let isFinal: Bool
}

// MARK: - IPC message structs

/// Sent to the daemon when live listening starts.
private struct LiveTranscriptStartMessage: Codable {
    let type = "live_transcript_start"
}

/// Sent to the daemon when live listening stops.
private struct LiveTranscriptStopMessage: Codable {
    let type = "live_transcript_stop"
}

/// Sent to the daemon for each finalized transcript segment.
private struct LiveTranscriptUpdateMessage: Codable {
    let type = "live_transcript_update"
    let text: String
    let timestamp: Double
    let isFinal: Bool
}

/// Coordinates SystemAudioCapture and LiveTranscriptionEngine to provide
/// continuous live transcription of system audio.
///
/// Maintains a rolling transcript buffer (last 10 minutes) and exposes
/// start/stop/status for UI binding. Handles conflicts with the wake word
/// engine by pausing it during live listening (same pattern as
/// WakeWordCoordinator pausing during voice mode).
@MainActor
final class LiveTranscriptManager: ObservableObject {

    enum Status: Equatable {
        case idle
        case starting
        case listening
        case error(String)
    }

    @Published private(set) var status: Status = .idle
    @Published private(set) var segments: [TranscriptSegment] = []
    @Published private(set) var currentPartialText: String = ""

    /// Whether the manager is actively capturing and transcribing.
    var isListening: Bool { status == .listening }

    private let audioCapture = SystemAudioCapture()
    private let transcriptionEngine = LiveTranscriptionEngine()

    /// Reference to the wake word monitor so we can pause/resume it.
    private weak var audioMonitor: AlwaysOnAudioMonitor?

    /// Reference to voice mode manager so we skip wake word resume while voice mode is active.
    private weak var voiceModeManager: VoiceModeManager?

    /// Daemon client for sending IPC messages.
    private weak var daemonClient: DaemonClient?

    /// Reference to the thread manager so we can create a transcript thread when listening stops.
    private weak var threadManager: ThreadManager?

    /// Rolling buffer duration — discard segments older than this.
    private static let bufferDuration: TimeInterval = 10 * 60 // 10 minutes

    /// Timer to prune old segments periodically.
    private var pruneTimer: Timer?

    /// Generation counter to detect stale async completions after stopListening().
    private var startGeneration = 0

    // MARK: - Init

    init(audioMonitor: AlwaysOnAudioMonitor? = nil) {
        self.audioMonitor = audioMonitor
        setupCallbacks()
    }

    /// Late-bind the audio monitor when it isn't available at init time
    /// (e.g. wake word coordinator is set up after the main window).
    func setAudioMonitor(_ monitor: AlwaysOnAudioMonitor) {
        self.audioMonitor = monitor
    }

    /// Late-bind the voice mode manager so we can check whether voice mode
    /// is active before resuming the wake word monitor.
    func setVoiceModeManager(_ manager: VoiceModeManager) {
        self.voiceModeManager = manager
    }

    /// Late-bind the daemon client for IPC communication.
    func setDaemonClient(_ client: DaemonClient) {
        self.daemonClient = client
    }

    /// Late-bind the thread manager so we can create a transcript thread
    /// when live listening stops.
    func setThreadManager(_ manager: ThreadManager) {
        self.threadManager = manager
    }

    // MARK: - Public API

    func startListening() {
        guard status == .idle || isErrorStatus else { return }

        status = .starting
        startGeneration += 1
        let currentGeneration = startGeneration
        log.info("Starting live audio capture and transcription")

        // Pause wake word engine to avoid SFSpeechRecognizer conflicts
        // (macOS only allows one active recognition task per process)
        if let monitor = audioMonitor, monitor.isListening {
            log.info("Pausing wake word engine for live transcription")
            monitor.stopMonitoring()
        }

        Task {
            do {
                try await audioCapture.start()

                // If stopListening() was called while we were awaiting, bail out
                guard self.status == .starting, self.startGeneration == currentGeneration else {
                    self.audioCapture.stop()
                    self.sendIPCStop()
                    return
                }

                guard transcriptionEngine.start() else {
                    log.error("Transcription engine failed to start")
                    status = .error("Speech recognition unavailable")
                    audioCapture.stop()
                    sendIPCStop()
                    resumeWakeWordIfNeeded()
                    return
                }

                status = .listening
                startPruneTimer()
                sendIPCStart()
                log.info("Live transcription active")
            } catch {
                // If stopListening() was called while we were awaiting, bail out
                guard self.status == .starting, self.startGeneration == currentGeneration else { return }

                log.error("Failed to start audio capture: \(error.localizedDescription, privacy: .public)")
                status = .error(error.localizedDescription)
                resumeWakeWordIfNeeded()
            }
        }
    }

    func stopListening() {
        guard status == .listening || status == .starting else { return }

        log.info("Stopping live audio capture and transcription")

        audioCapture.stop()
        transcriptionEngine.stop()
        pruneTimer?.invalidate()
        pruneTimer = nil

        // Flush the current partial as a final segment
        if !currentPartialText.isEmpty {
            let segment = TranscriptSegment(text: currentPartialText, timestamp: Date(), isFinal: true)
            segments.append(segment)
            sendIPCUpdate(segment)
            currentPartialText = ""
        }

        sendIPCStop()

        // Create a new thread with the transcript if we captured anything
        createTranscriptThreadIfNeeded()

        status = .idle

        resumeWakeWordIfNeeded()

        log.info("Live transcription stopped")
    }

    func toggleListening() {
        if isListening || status == .starting {
            stopListening()
        } else {
            startListening()
        }
    }

    /// Clear all buffered transcript segments.
    func clearTranscript() {
        segments.removeAll()
        currentPartialText = ""
    }

    /// The full rolling transcript as a single string.
    var fullTranscript: String {
        let finalized = segments.map(\.text).joined(separator: " ")
        if currentPartialText.isEmpty {
            return finalized
        }
        return finalized.isEmpty ? currentPartialText : finalized + " " + currentPartialText
    }

    // MARK: - Private

    private func createTranscriptThreadIfNeeded() {
        guard !segments.isEmpty else { return }
        guard let threadManager else {
            log.warning("No thread manager available — skipping transcript thread creation")
            return
        }

        let segmentCount = segments.count
        let transcriptText = formatTranscript()

        // Save the original view model and any draft before switching threads.
        let originalViewModel = threadManager.activeViewModel
        let existingDraft = originalViewModel?.inputText ?? ""

        threadManager.createThread()

        guard let transcriptViewModel = threadManager.activeViewModel else {
            log.error("Failed to get active view model for transcript thread")
            return
        }

        // Set the transcript text and send it
        transcriptViewModel.inputText = transcriptText
        transcriptViewModel.sendMessage()

        // Restore the user's draft if they had unsent text.
        // If createThread() created a new thread, restore to the original.
        // If it reused the current empty thread, restore to that same VM
        // (sendMessage clears inputText, so the draft would otherwise be lost).
        if !existingDraft.isEmpty, let originalViewModel {
            originalViewModel.inputText = existingDraft
        }

        log.info("Created transcript thread with \(segmentCount) segments")

        // Clear the buffer now that it's been captured in a thread
        segments.removeAll()
    }

    private func formatTranscript() -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm:ss"

        var lines: [String] = []
        lines.append("## Audio Transcript")
        lines.append("[captured from system audio]")
        lines.append("")

        for segment in segments {
            let timestamp = formatter.string(from: segment.timestamp)
            lines.append("[\(timestamp)] \(segment.text)")
        }

        return lines.joined(separator: "\n")
    }

    private var isErrorStatus: Bool {
        if case .error = status { return true }
        return false
    }

    private func setupCallbacks() {
        // Wire audio buffers from capture -> transcription engine
        audioCapture.onAudioBuffer = { [weak self] sampleBuffer in
            self?.transcriptionEngine.appendAudioBuffer(sampleBuffer)
        }

        // Handle stream errors
        audioCapture.onStreamError = { [weak self] error in
            Task { @MainActor [weak self] in
                guard let self, self.isListening else { return }
                log.error("Audio capture stream error: \(error.localizedDescription, privacy: .public)")
                self.status = .error(error.localizedDescription)
                self.transcriptionEngine.stop()
                self.sendIPCStop()
                self.resumeWakeWordIfNeeded()
            }
        }

        // Handle transcription results
        transcriptionEngine.onTranscription = { [weak self] text, isFinal in
            Task { @MainActor [weak self] in
                guard let self else { return }
                self.handleTranscription(text: text, isFinal: isFinal)
            }
        }
    }

    private func handleTranscription(text: String, isFinal: Bool) {
        if isFinal {
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty {
                let segment = TranscriptSegment(text: trimmed, timestamp: Date(), isFinal: true)
                segments.append(segment)
                sendIPCUpdate(segment)
            }
            currentPartialText = ""
        } else {
            currentPartialText = text
        }
    }

    // MARK: - IPC

    private func sendIPCStart() {
        guard let client = daemonClient else {
            log.debug("No daemon client available for live_transcript_start")
            return
        }
        do {
            try client.send(LiveTranscriptStartMessage())
        } catch {
            log.error("Failed to send live_transcript_start: \(error.localizedDescription, privacy: .public)")
        }
    }

    private func sendIPCStop() {
        guard let client = daemonClient else {
            log.debug("No daemon client available for live_transcript_stop")
            return
        }
        do {
            try client.send(LiveTranscriptStopMessage())
        } catch {
            log.error("Failed to send live_transcript_stop: \(error.localizedDescription, privacy: .public)")
        }
    }

    private func sendIPCUpdate(_ segment: TranscriptSegment) {
        guard let client = daemonClient else {
            log.debug("No daemon client available for live_transcript_update")
            return
        }
        do {
            let msg = LiveTranscriptUpdateMessage(
                text: segment.text,
                timestamp: segment.timestamp.timeIntervalSince1970 * 1000,
                isFinal: segment.isFinal
            )
            try client.send(msg)
        } catch {
            log.error("Failed to send live_transcript_update: \(error.localizedDescription, privacy: .public)")
        }
    }

    private func resumeWakeWordIfNeeded() {
        guard let monitor = audioMonitor else { return }
        guard UserDefaults.standard.bool(forKey: "wakeWordEnabled") else { return }

        // Delay to let audio engine fully release.
        // Voice mode check is inside the closure so it evaluates state
        // AFTER the delay — avoids a race where voice mode activates
        // during the 1-second window.
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [weak self, weak monitor] in
            guard let monitor, !monitor.isListening else { return }

            // Don't resume wake word if voice mode is active — it uses
            // SFSpeechRecognizer too and macOS only allows one active
            // recognition task per process.
            if let voiceModeManager = self?.voiceModeManager, voiceModeManager.state != .off {
                log.info("Skipping wake word resume — voice mode is active")
                return
            }

            log.info("Resuming wake word engine after live transcription stopped")
            monitor.startMonitoring()
        }
    }

    private func startPruneTimer() {
        pruneTimer?.invalidate()
        pruneTimer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in
                self?.pruneOldSegments()
            }
        }
    }

    private func pruneOldSegments() {
        let cutoff = Date().addingTimeInterval(-Self.bufferDuration)
        let before = segments.count
        segments.removeAll { $0.timestamp < cutoff }
        let pruned = before - segments.count
        if pruned > 0 {
            log.debug("Pruned \(pruned, privacy: .public) old transcript segments")
        }
    }
}
