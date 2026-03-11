import Foundation
import AVFoundation
import Speech
import os

private let log = Logger(subsystem: "com.vellum.vellum-assistant", category: "OpenAIVoiceService")

enum VoiceServiceError: Error, LocalizedError {
    case speechRecognitionUnavailable
    case notAuthorized
    case noAPIKey
    case invalidResponse
    case apiError(statusCode: Int, message: String)
    case noAudioData
    case noTranscription

    var errorDescription: String? {
        switch self {
        case .speechRecognitionUnavailable: return "Speech recognition unavailable"
        case .notAuthorized: return "Speech recognition not authorized"
        case .noAPIKey: return "API key not configured"
        case .invalidResponse: return "Invalid API response"
        case .apiError(let code, let msg): return "API error (\(code)): \(msg)"
        case .noAudioData: return "No audio data recorded"
        case .noTranscription: return "No transcription result"
        }
    }
}

/// Voice service: SFSpeechRecognizer STT (on-device) + TTS (ElevenLabs REST API).
/// Records audio, detects silence, transcribes via SFSpeechRecognizer, speaks via ElevenLabs.
@MainActor
final class OpenAIVoiceService: ObservableObject, VoiceServiceProtocol {
    @Published var amplitude: Float = 0
    @Published var speakingAmplitude: Float = 0
    @Published var livePartialText: String = ""

    // MARK: - Recording State

    private let audioEngine = AVAudioEngine()
    private var isRecording = false

    /// Fires once when silence is detected after speech.
    var onSilenceDetected: (() -> Void)?
    /// Callback fired when mic permission is granted after being requested.
    var onMicrophoneAuthorized: (() -> Void)?
    /// Fires when speech is detected during TTS playback (barge-in).
    var onBargeInDetected: (() -> Void)?

    private var lastSpeechTime = Date()
    private var recordingStartTime: Date?
    private var silenceHandled = false
    private var hasSpeechOccurred = false
    private var enginePrewarmed = false
    private var rmsLogCounter = 0

    private static let silenceThreshold: Float = 0.003
    private static let speechThreshold: Float = 0.003
    private static let silenceTimeout: TimeInterval = 1.0
    private static let minRecordingDuration: TimeInterval = 0.5

    // MARK: - SFSpeechRecognizer STT State

    private var speechRecognizer: SFSpeechRecognizer?
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    /// The latest transcription text from the ongoing recognition task.
    private var latestTranscription: String = ""
    /// Continuation to deliver the final transcription when recording stops.
    private var transcriptionContinuation: CheckedContinuation<String?, Never>?

    // MARK: - ElevenLabs TTS State

    /// Accumulated text from streaming deltas — sent to ElevenLabs when response completes.
    private var ttsTextBuffer = ""
    private var ttsOnComplete: (() -> Void)?
    private var audioPlayer: AVAudioPlayer?
    private var speakingTimer: Timer?
    private var ttsTask: Task<Void, Never>?

    /// Default ElevenLabs voice — "Rachel" (calm, warm, conversational).
    /// Mirrored from: assistant/src/config/elevenlabs-schema.ts (DEFAULT_ELEVENLABS_VOICE_ID)
    private static let defaultVoiceId = "21m00Tcm4TlvDq8ikWAM"

    /// ElevenLabs voice ID — reads from UserDefaults (set via daemon HTTP), falls back to Rachel.
    private static var elevenLabsVoiceId: String {
        UserDefaults.standard.string(forKey: "ttsVoiceId").flatMap { $0.isEmpty ? nil : $0 }
            ?? Self.defaultVoiceId
    }

    nonisolated init() {}

    // MARK: - API Keys

    var elevenLabsKey: String? { APIKeyManager.getKey(for: "elevenlabs") }
    var hasElevenLabsKey: Bool { elevenLabsKey != nil }

    // MARK: - Speech Recognition Authorization

    /// Check if speech recognition is authorized. Returns true if authorized.
    nonisolated static func isSpeechRecognitionAuthorized() -> Bool {
        SFSpeechRecognizer.authorizationStatus() == .authorized
    }

    /// Request speech recognition authorization if not yet determined.
    nonisolated static func requestSpeechRecognitionAuthorization(completion: @escaping (Bool) -> Void) {
        let status = SFSpeechRecognizer.authorizationStatus()
        switch status {
        case .authorized:
            completion(true)
        case .notDetermined:
            SFSpeechRecognizer.requestAuthorization { newStatus in
                DispatchQueue.main.async {
                    completion(newStatus == .authorized)
                }
            }
        default:
            completion(false)
        }
    }

    // MARK: - Recording

    /// Pre-initialize the audio engine so the first recording starts instantly.
    func prewarmEngine() {
        guard !enginePrewarmed else { return }
        let _ = audioEngine.inputNode
        enginePrewarmed = true
        log.info("Audio engine pre-warmed")
    }

    @discardableResult
    func startRecording() -> Bool {
        guard !isRecording else { return false }

        silenceHandled = false
        hasSpeechOccurred = false
        rmsLogCounter = 0
        latestTranscription = ""
        livePartialText = ""

        let inputNode = audioEngine.inputNode
        let format = inputNode.outputFormat(forBus: 0)

        guard format.channelCount > 0 else {
            log.error("No audio input channels")
            return false
        }

        // Reuse existing SFSpeechRecognizer across turns to avoid OS resource
        // release delays that make isAvailable return false on the second turn.
        if speechRecognizer == nil {
            speechRecognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
        }
        guard let recognizer = speechRecognizer, recognizer.isAvailable else {
            log.error("SFSpeechRecognizer not available")
            return false
        }

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        if recognizer.supportsOnDeviceRecognition {
            request.requiresOnDeviceRecognition = true
        }
        request.addsPunctuation = false
        recognitionRequest = request

        // Start recognition task
        recognitionTask = recognizer.recognitionTask(with: request) { [weak self] result, error in
            guard let self else { return }

            if let result {
                let text = result.bestTranscription.formattedString
                log.debug("Partial transcription: \(text, privacy: .public)")
                Task { @MainActor [weak self] in
                    self?.latestTranscription = text
                    self?.livePartialText = text
                }

                if result.isFinal {
                    let finalText = text
                    Task { @MainActor [weak self] in
                        guard let self else { return }
                        log.info("Final transcription: \(finalText, privacy: .public)")
                        self.transcriptionContinuation?.resume(returning: finalText.isEmpty ? nil : finalText)
                        self.transcriptionContinuation = nil
                    }
                }
            }

            if let error {
                let nsError = error as NSError
                // Ignore cancellation errors (code 216) — expected when we call endAudio()
                if nsError.domain == "kAFAssistantErrorDomain" && nsError.code == 216 {
                    return
                }
                // Code 1110 = "no speech detected" — not a real error, just empty input
                if nsError.domain == "kAFAssistantErrorDomain" && nsError.code == 1110 {
                    log.info("No speech detected in audio")
                    Task { @MainActor [weak self] in
                        guard let self else { return }
                        self.transcriptionContinuation?.resume(returning: nil)
                        self.transcriptionContinuation = nil
                    }
                    return
                }
                log.error("Recognition error: \(nsError.domain, privacy: .public)/\(nsError.code, privacy: .public) \(error.localizedDescription, privacy: .public)")
                Task { @MainActor [weak self] in
                    guard let self else { return }
                    // If we have partial transcription, use it despite the error
                    let text = self.latestTranscription
                    self.transcriptionContinuation?.resume(returning: text.isEmpty ? nil : text)
                    self.transcriptionContinuation = nil
                }
            }
        }

        // Install audio tap — feeds buffers to SFSpeechRecognizer + computes RMS for amplitude
        inputNode.installTap(onBus: 0, bufferSize: 4096, format: format) { [weak self] buffer, _ in
            guard let floatData = buffer.floatChannelData else { return }
            let frameCount = Int(buffer.frameLength)
            guard frameCount > 0 else { return }

            // Feed buffer to speech recognizer
            request.append(buffer)

            // Compute RMS for amplitude display and silence detection
            var sum: Float = 0
            for i in 0..<frameCount {
                let sample = floatData[0][i]
                sum += sample * sample
            }
            let rms = sqrt(sum / Float(frameCount))

            Task { @MainActor [weak self] in
                guard let self, self.isRecording else { return }
                self.amplitude = min(rms * 5, 1.0)

                // Log RMS every ~50 buffers (~1s) for diagnostics
                self.rmsLogCounter += 1
                if self.rmsLogCounter % 50 == 0 {
                    log.info("Voice RMS: \(rms, privacy: .public) (speech threshold: \(Self.speechThreshold, privacy: .public), hasSpeech: \(self.hasSpeechOccurred, privacy: .public))")
                }

                if rms > Self.speechThreshold {
                    self.hasSpeechOccurred = true
                }
                if rms > Self.silenceThreshold {
                    self.lastSpeechTime = Date()
                }
                let silenceDuration = Date().timeIntervalSince(self.lastSpeechTime)
                let recordingDuration = self.recordingStartTime.map { Date().timeIntervalSince($0) } ?? 0
                if !self.silenceHandled,
                   self.hasSpeechOccurred,
                   recordingDuration > Self.minRecordingDuration,
                   silenceDuration > Self.silenceTimeout {
                    log.info("Silence detected: rms=\(rms, privacy: .public) silenceDuration=\(silenceDuration, privacy: .public)")
                    self.silenceHandled = true
                    self.onSilenceDetected?()
                }
            }
        }

        do {
            audioEngine.prepare()
            try audioEngine.start()
            isRecording = true
            lastSpeechTime = Date()
            recordingStartTime = Date()
            log.info("Recording started (SFSpeechRecognizer, onDevice: \(recognizer.supportsOnDeviceRecognition, privacy: .public))")
            return true
        } catch {
            log.error("Failed to start audio engine: \(error.localizedDescription)")
            audioEngine.inputNode.removeTap(onBus: 0)
            tearDownRecognition()
            return false
        }
    }

    /// Stop recording and return the transcription from SFSpeechRecognizer.
    func stopRecordingAndGetTranscription() async -> String? {
        guard isRecording else { return nil }

        isRecording = false
        amplitude = 0

        if audioEngine.isRunning {
            audioEngine.stop()
            audioEngine.inputNode.removeTap(onBus: 0)
        }

        // Signal end of audio to the recognizer
        recognitionRequest?.endAudio()

        // If we already have transcription text, return it immediately
        // (the final callback may not fire for short utterances)
        let currentText = latestTranscription.trimmingCharacters(in: .whitespacesAndNewlines)
        if !currentText.isEmpty {
            log.info("Returning current transcription: \(currentText, privacy: .public)")
            tearDownRecognition()
            recordingStartTime = nil
            return currentText
        }

        // Wait briefly for the final result from the recognition task
        let result: String? = await withCheckedContinuation { continuation in
            self.transcriptionContinuation = continuation

            // Timeout: don't wait forever if recognizer doesn't respond
            Task {
                try? await Task.sleep(nanoseconds: 2_000_000_000) // 2s timeout
                if let cont = self.transcriptionContinuation {
                    self.transcriptionContinuation = nil
                    let text = self.latestTranscription.trimmingCharacters(in: .whitespacesAndNewlines)
                    cont.resume(returning: text.isEmpty ? nil : text)
                }
            }
        }

        tearDownRecognition()
        recordingStartTime = nil

        log.info("Recording stopped, transcription: \(result ?? "<none>", privacy: .public)")
        return result
    }

    /// Force stop recording without returning transcription.
    func cancelRecording() {
        guard isRecording else { return }
        isRecording = false
        amplitude = 0
        if audioEngine.isRunning {
            audioEngine.stop()
            audioEngine.inputNode.removeTap(onBus: 0)
        }
        // Resume any waiting continuation with nil
        transcriptionContinuation?.resume(returning: nil)
        transcriptionContinuation = nil
        tearDownRecognition()
        recordingStartTime = nil
    }

    /// Fully shut down the audio engine and release the microphone.
    func shutdown() {
        cancelRecording()
        stopBargeInMonitor()
        stopSpeaking()
        if audioEngine.isRunning {
            audioEngine.stop()
        }
        speechRecognizer = nil
        enginePrewarmed = false
        log.info("Audio engine shut down")
    }

    private func tearDownRecognition() {
        recognitionTask?.cancel()
        recognitionTask = nil
        recognitionRequest = nil
        // Keep speechRecognizer alive — reused across turns.
        // Only destroy it on full shutdown().
        latestTranscription = ""
        livePartialText = ""
    }

    // MARK: - ElevenLabs TTS (REST API)

    /// Called with each text delta — just accumulates text.
    func feedTextDelta(_ delta: String) {
        ttsTextBuffer += delta
    }

    /// Called when the full response is complete — sends accumulated text to ElevenLabs.
    func finishTextStream(onComplete: @escaping () -> Void) {
        let raw = ttsTextBuffer.trimmingCharacters(in: .whitespacesAndNewlines)
        let text = TTSRedactor.redact(raw)
        ttsTextBuffer = ""

        guard !text.isEmpty, elevenLabsKey != nil else {
            log.info("TTS: no text or no ElevenLabs key, completing immediately")
            onComplete()
            return
        }

        ttsOnComplete = onComplete
        startSpeakingAmplitudePolling()

        ttsTask = Task {
            do {
                let audioData = try await fetchElevenLabsTTS(text: text)
                guard !Task.isCancelled else { return }

                let player = try AVAudioPlayer(data: audioData)
                self.audioPlayer = player
                player.delegate = nil // We poll for completion below
                player.play()
                log.info("TTS: playing \(audioData.count) bytes of audio")

                // Poll until playback finishes
                while player.isPlaying && !Task.isCancelled {
                    try await Task.sleep(nanoseconds: 100_000_000) // 100ms
                }

                guard !Task.isCancelled else { return }
                log.info("TTS: playback complete")
            } catch {
                if !Task.isCancelled {
                    log.error("TTS error: \(error.localizedDescription)")
                }
            }

            self.audioPlayer = nil
            self.finishSpeaking()
            self.ttsOnComplete?()
            self.ttsOnComplete = nil
        }
    }

    /// Reset TTS state for a new conversation turn.
    func resetStreamingTTS() {
        ttsTextBuffer = ""
        ttsOnComplete = nil
    }

    func stopSpeaking() {
        ttsTask?.cancel()
        ttsTask = nil
        audioPlayer?.stop()
        audioPlayer = nil
        stopBargeInMonitor()
        finishSpeaking()
        ttsOnComplete?()
        ttsOnComplete = nil
    }

    private func finishSpeaking() {
        stopSpeakingAmplitudePolling()
        stopBargeInMonitor()
        speakingAmplitude = 0
    }

    // MARK: - Barge-in (interrupt TTS by speaking)

    private var bargeInMonitorActive = false

    /// Start monitoring the mic for speech during TTS playback.
    /// Uses a higher threshold than normal to avoid picking up speaker output.
    func startBargeInMonitor() {
        guard !bargeInMonitorActive else { return }
        bargeInMonitorActive = true

        let inputNode = audioEngine.inputNode
        let format = inputNode.outputFormat(forBus: 0)
        guard format.channelCount > 0 else { return }

        inputNode.installTap(onBus: 0, bufferSize: 4096, format: format) { [weak self] buffer, _ in
            guard let floatData = buffer.floatChannelData else { return }
            let frameCount = Int(buffer.frameLength)
            guard frameCount > 0 else { return }

            var sum: Float = 0
            for i in 0..<frameCount {
                let s = floatData[0][i]
                sum += s * s
            }
            let rms = sqrt(sum / Float(frameCount))

            // Higher threshold to avoid picking up TTS speaker output
            if rms > 0.05 {
                Task { @MainActor [weak self] in
                    guard let self, self.bargeInMonitorActive else { return }
                    log.info("Barge-in detected: rms=\(rms, privacy: .public)")
                    self.stopBargeInMonitor()
                    self.onBargeInDetected?()
                }
            }
        }

        do {
            audioEngine.prepare()
            try audioEngine.start()
            log.info("Barge-in monitor started")
        } catch {
            log.error("Failed to start barge-in monitor: \(error.localizedDescription)")
            audioEngine.inputNode.removeTap(onBus: 0)
            bargeInMonitorActive = false
        }
    }

    func stopBargeInMonitor() {
        guard bargeInMonitorActive else { return }
        bargeInMonitorActive = false
        if audioEngine.isRunning {
            audioEngine.stop()
            audioEngine.inputNode.removeTap(onBus: 0)
        }
    }

    /// Call ElevenLabs REST API to convert text to speech. Returns MP3 audio data.
    private func fetchElevenLabsTTS(text: String) async throws -> Data {
        guard let elevenLabsKey else {
            throw VoiceServiceError.noAPIKey
        }

        let voiceId = Self.elevenLabsVoiceId
        let url = URL(string: "https://api.elevenlabs.io/v1/text-to-speech/\(voiceId)")!
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue(elevenLabsKey, forHTTPHeaderField: "xi-api-key")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("audio/mpeg", forHTTPHeaderField: "Accept")
        request.timeoutInterval = 30

        let body: [String: Any] = [
            "text": text,
            "model_id": "eleven_flash_v2_5",
            "voice_settings": [
                "stability": 0.5,
                "similarity_boost": 0.75,
                "speed": 1.1
            ]
        ]
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, response) = try await URLSession.shared.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse else {
            throw VoiceServiceError.invalidResponse
        }

        guard httpResponse.statusCode == 200 else {
            let errorBody = String(data: data, encoding: .utf8) ?? "Unknown error"
            log.error("ElevenLabs API error (\(httpResponse.statusCode)): \(errorBody)")
            throw VoiceServiceError.apiError(statusCode: httpResponse.statusCode, message: errorBody)
        }

        guard !data.isEmpty else {
            throw VoiceServiceError.noAudioData
        }

        return data
    }

    // MARK: - Speaking Amplitude

    private func startSpeakingAmplitudePolling() {
        speakingTimer = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self, self.audioPlayer?.isPlaying == true else { return }
                let target = Float.random(in: 0.3...0.8)
                // Smooth toward target to avoid jerky jumps
                self.speakingAmplitude = self.speakingAmplitude * 0.7 + target * 0.3
            }
        }
    }

    private func stopSpeakingAmplitudePolling() {
        speakingTimer?.invalidate()
        speakingTimer = nil
    }
}
