import AVFoundation
import Foundation
import Speech
import os

private let log = Logger(subsystem: "com.vellum.vellum-assistant", category: "SpeechWakeWordEngine")

/// Wake word engine backed by Apple's `SFSpeechRecognizer` doing on-device
/// keyword spotting. No third-party dependency, no API key required.
///
/// Owns its own `AVAudioEngine` and installs a tap that feeds buffers
/// directly to `SFSpeechAudioBufferRecognitionRequest` — the same pattern
/// used by `VoiceInputManager` and recommended by Apple.
///
/// SFSpeechRecognizer has a ~60s recognition task timeout. This engine
/// handles it with rolling sessions: proactively restarting every ~55s,
/// plus restarting on error/completion callbacks.
final class SpeechWakeWordEngine: WakeWordEngine {

    var onWakeWordDetected: ((Float) -> Void)?

    private(set) var isRunning = false

    /// The keyword phrase to detect (e.g. "computer", "hey vellum").
    let keyword: String

    private let audioEngine = AVAudioEngine()
    private var speechRecognizer: SFSpeechRecognizer?
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private var restartTimer: Timer?

    /// Prevents duplicate fires within a single recognition session.
    private var detectedInCurrentSession = false

    /// Consecutive restart failures — used for exponential backoff.
    private var consecutiveFailures = 0
    private static let maxBackoffSeconds: TimeInterval = 30

    /// Word-boundary regex for matching the keyword in transcriptions.
    private let keywordPattern: Regex<Substring>?

    /// Rolling session duration — restart before the ~60s timeout.
    private static let sessionDuration: TimeInterval = 55

    init(keyword: String = "computer") {
        self.keyword = keyword
        let escaped = NSRegularExpression.escapedPattern(for: keyword)
        self.keywordPattern = try? Regex("(?i)\\b\(escaped)\\b")
    }

    // MARK: - WakeWordEngine

    func start() throws {
        guard !isRunning else { return }

        guard keywordPattern != nil else {
            log.error("Failed to compile keyword regex for '\(self.keyword)' — wake word detection disabled")
            return
        }

        // Check speech recognition authorization
        let authStatus = SFSpeechRecognizer.authorizationStatus()
        switch authStatus {
        case .notDetermined:
            log.info("Speech recognition authorization not determined — requesting")
            SFSpeechRecognizer.requestAuthorization { [weak self] status in
                DispatchQueue.main.async {
                    if status == .authorized {
                        log.info("Speech recognition authorized — starting engine")
                        try? self?.start()
                    } else {
                        log.warning("Speech recognition authorization denied (\(String(describing: status), privacy: .public))")
                    }
                }
            }
            return
        case .denied, .restricted:
            log.warning("Speech recognition not authorized (status: \(String(describing: authStatus), privacy: .public)) — wake word detection disabled")
            return
        case .authorized:
            break
        @unknown default:
            break
        }

        let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
        guard let recognizer, recognizer.isAvailable else {
            log.warning("SFSpeechRecognizer not available — wake word detection disabled")
            return
        }

        self.speechRecognizer = recognizer
        isRunning = true
        consecutiveFailures = 0

        startRecognitionSession()
        scheduleRestartTimer()

        log.info("SpeechWakeWordEngine started (keyword: \(self.keyword, privacy: .public), onDevice: \(recognizer.supportsOnDeviceRecognition, privacy: .public))")
    }

    func stop() {
        guard isRunning else { return }
        isRunning = false

        restartTimer?.invalidate()
        restartTimer = nil

        tearDownSession()

        speechRecognizer = nil

        log.info("SpeechWakeWordEngine stopped")
    }

    // MARK: - Recognition session management

    private func startRecognitionSession() {
        guard isRunning else { return }
        guard let speechRecognizer, speechRecognizer.isAvailable else {
            log.warning("Speech recognizer unavailable, will retry on next restart cycle")
            return
        }

        // 1. Create the recognition request
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        if speechRecognizer.supportsOnDeviceRecognition {
            request.requiresOnDeviceRecognition = true
        }
        request.addsPunctuation = false
        // Bias the recognizer toward the keyword so uncommon words
        // (e.g. "vellum") are transcribed correctly instead of
        // close-sounding alternatives like "Val" or "bellum".
        request.contextualStrings = [keyword]
        self.recognitionRequest = request

        detectedInCurrentSession = false

        // 2. Install audio tap that feeds buffers directly to the request
        let inputNode = audioEngine.inputNode
        let recordingFormat = inputNode.outputFormat(forBus: 0)

        guard recordingFormat.channelCount > 0 else {
            log.error("No audio input channels available")
            return
        }

        inputNode.installTap(onBus: 0, bufferSize: 1024, format: recordingFormat) { buffer, _ in
            request.append(buffer)
        }

        // 3. Create the recognition task
        let sessionStartTime = Date()

        recognitionTask = speechRecognizer.recognitionTask(with: request) { [weak self] result, error in
            guard let self else { return }

            if let result {
                let text = result.bestTranscription.formattedString
                log.debug("Transcription: \(text, privacy: .public)")
                self.checkForKeyword(in: text)
            }

            if error != nil || (result?.isFinal == true) {
                let sessionDuration = Date().timeIntervalSince(sessionStartTime)

                if let error {
                    let nsError = error as NSError
                    if nsError.domain != "kAFAssistantErrorDomain" || nsError.code != 216 {
                        log.error("Recognition ended after \(String(format: "%.1f", sessionDuration), privacy: .public)s: \(nsError.domain, privacy: .public)/\(nsError.code, privacy: .public) \(error.localizedDescription, privacy: .public)")
                    }
                }

                DispatchQueue.main.async { [weak self] in
                    guard let self, self.isRunning else { return }

                    if sessionDuration < 1.0 {
                        self.consecutiveFailures += 1
                        let backoff = min(
                            pow(2.0, Double(self.consecutiveFailures)),
                            Self.maxBackoffSeconds
                        )
                        log.warning("Session failed fast (\(self.consecutiveFailures, privacy: .public)x) — retry in \(String(format: "%.0f", backoff), privacy: .public)s")
                        DispatchQueue.main.asyncAfter(deadline: .now() + backoff) { [weak self] in
                            guard let self, self.isRunning else { return }
                            self.restartSession()
                        }
                    } else {
                        self.consecutiveFailures = 0
                        self.restartSession()
                    }
                }
            }
        }

        // 4. Start the audio engine
        audioEngine.prepare()
        do {
            try audioEngine.start()
            log.debug("Recognition session started")
        } catch {
            log.error("Audio engine failed to start: \(error.localizedDescription, privacy: .public)")
            tearDownSession()
        }
    }

    private func tearDownSession() {
        if audioEngine.isRunning {
            audioEngine.stop()
        }
        audioEngine.inputNode.removeTap(onBus: 0)

        recognitionRequest?.endAudio()
        recognitionRequest = nil
        recognitionTask?.cancel()
        recognitionTask = nil
        detectedInCurrentSession = false
    }

    private func restartSession() {
        guard isRunning else { return }
        tearDownSession()
        startRecognitionSession()
    }

    private func scheduleRestartTimer() {
        restartTimer?.invalidate()
        restartTimer = Timer.scheduledTimer(withTimeInterval: Self.sessionDuration, repeats: true) { [weak self] _ in
            guard let self, self.isRunning else { return }
            self.consecutiveFailures = 0
            self.restartSession()
        }
    }

    // MARK: - Keyword matching

    private func checkForKeyword(in text: String) {
        guard !detectedInCurrentSession, let keywordPattern else { return }

        if text.contains(keywordPattern) {
            detectedInCurrentSession = true
            log.info("Keyword '\(self.keyword, privacy: .public)' detected in: '\(text, privacy: .public)'")
            onWakeWordDetected?(1.0)
        }
    }
}
