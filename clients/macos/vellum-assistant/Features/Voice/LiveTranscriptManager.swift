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
                    return
                }

                guard transcriptionEngine.start() else {
                    log.error("Transcription engine failed to start")
                    status = .error("Speech recognition unavailable")
                    audioCapture.stop()
                    resumeWakeWordIfNeeded()
                    return
                }

                status = .listening
                startPruneTimer()
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
            currentPartialText = ""
        }

        status = .idle

        resumeWakeWordIfNeeded()

        log.info("Live transcription stopped. Total segments: \(self.segments.count)")
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
                logTranscriptForIPC(segment)
            }
            currentPartialText = ""
        } else {
            currentPartialText = text
        }
    }

    /// Placeholder for M2 IPC integration. For now, logs the transcript
    /// segment locally. When IPC message types are defined, this will
    /// send transcript updates to the daemon.
    private func logTranscriptForIPC(_ segment: TranscriptSegment) {
        let formatter = ISO8601DateFormatter()
        log.info("Transcript segment [\(formatter.string(from: segment.timestamp), privacy: .public)]: \(segment.text, privacy: .public)")
    }

    private func resumeWakeWordIfNeeded() {
        guard let monitor = audioMonitor else { return }
        guard UserDefaults.standard.bool(forKey: "wakeWordEnabled") else { return }

        // Delay to let audio engine fully release
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [weak monitor] in
            guard let monitor, !monitor.isListening else { return }
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
