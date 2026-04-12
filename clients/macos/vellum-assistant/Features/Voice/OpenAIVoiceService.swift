import Foundation
import AVFoundation
import Speech
import VellumAssistantShared
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "OpenAIVoiceService")

enum VoiceServiceError: Error, LocalizedError {
    case speechRecognitionUnavailable
    case notAuthorized
    case invalidResponse
    case noAudioData
    case noTranscription

    var errorDescription: String? {
        switch self {
        case .speechRecognitionUnavailable: return "Speech recognition unavailable"
        case .notAuthorized: return "Speech recognition not authorized"
        case .invalidResponse: return "Invalid API response"
        case .noAudioData: return "No audio data recorded"
        case .noTranscription: return "No transcription result"
        }
    }
}

/// Voice service: service-first STT + Apple fallback + gateway TTS.
/// Records audio, detects silence, captures per-turn PCM for service STT,
/// runs live SFSpeechRecognizer for partial text and fallback transcription,
/// speaks via the assistant's `/v1/tts/synthesize` endpoint.
@MainActor
@Observable
final class OpenAIVoiceService: VoiceServiceProtocol {
    var amplitude: Float = 0
    var speakingAmplitude: Float = 0
    var livePartialText: String = ""

    // MARK: - Speech Recognizer Adapter

    /// Injected adapter wrapping SFSpeechRecognizer static APIs and instance creation.
    @ObservationIgnored let speechRecognizerAdapter: any SpeechRecognizerAdapter

    // MARK: - Recording State

    @ObservationIgnored private let engineController = AudioEngineController(label: "com.vellum.audioEngine.voiceService")
    @ObservationIgnored private var isRecording = false

    /// Fires once when silence is detected after speech.
    @ObservationIgnored var onSilenceDetected: (() -> Void)?
    /// Callback fired when mic permission is granted after being requested.
    @ObservationIgnored var onMicrophoneAuthorized: (() -> Void)?
    /// Fires when speech is detected during TTS playback (barge-in).
    @ObservationIgnored var onBargeInDetected: (() -> Void)?

    @ObservationIgnored private var lastSpeechTime = Date()
    @ObservationIgnored private var recordingStartTime: Date?
    @ObservationIgnored private var silenceHandled = false
    @ObservationIgnored private var hasSpeechOccurred = false
    @ObservationIgnored private var enginePrewarmed = false
    @ObservationIgnored private var rmsLogCounter = 0

    private static let silenceThreshold: Float = 0.003
    private static let speechThreshold: Float = 0.003
    private static let silenceTimeout: TimeInterval = 1.0
    private static let minRecordingDuration: TimeInterval = 0.5

    // MARK: - SFSpeechRecognizer STT State

    @ObservationIgnored private var speechRecognizer: SFSpeechRecognizer?
    @ObservationIgnored private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    @ObservationIgnored private var recognitionTask: SFSpeechRecognitionTask?
    /// The latest transcription text from the ongoing recognition task.
    @ObservationIgnored private var latestTranscription: String = ""
    /// Continuation to deliver the final transcription when recording stops.
    @ObservationIgnored private var transcriptionContinuation: CheckedContinuation<String?, Never>?

    // MARK: - Per-Turn Audio Capture (for service STT)

    /// Raw 16-bit PCM samples accumulated during the current recording turn.
    /// Converted from the tap's float32 buffers on the fly, then WAV-encoded
    /// and sent to the STT service at turn end.
    @ObservationIgnored private var capturedPCMData = Data()
    /// Sample rate of the captured audio, recorded from the tap's buffer format.
    @ObservationIgnored private var capturedSampleRate: Int = 16000

    /// Gateway STT client — routes through the assistant's configured STT service.
    @ObservationIgnored private let sttClient: any STTClientProtocol

    // MARK: - TTS State

    /// Accumulated text from streaming deltas — sent to the gateway when response completes.
    @ObservationIgnored private var ttsTextBuffer = ""
    @ObservationIgnored private var ttsOnComplete: (() -> Void)?
    @ObservationIgnored private var audioPlayer: AVAudioPlayer?
    @ObservationIgnored private var speakingTimer: Timer?
    @ObservationIgnored private var ttsTask: Task<Void, Never>?

    /// Gateway TTS client — routes through the provider selected by `services.tts.provider`.
    @ObservationIgnored private let ttsClient: any TTSClientProtocol

    /// Current conversation ID, set by VoiceModeManager on activation.
    /// Passed to TTSClient for provider context.
    @ObservationIgnored var conversationId: String?

    nonisolated init(
        ttsClient: any TTSClientProtocol = TTSClient(),
        sttClient: any STTClientProtocol = STTClient(),
        speechRecognizerAdapter: any SpeechRecognizerAdapter = AppleSpeechRecognizerAdapter()
    ) {
        self.ttsClient = ttsClient
        self.sttClient = sttClient
        self.speechRecognizerAdapter = speechRecognizerAdapter
    }

    // MARK: - Speech Recognition Authorization

    /// Check if speech recognition is authorized. Returns true if authorized.
    nonisolated func isSpeechRecognitionAuthorized() -> Bool {
        speechRecognizerAdapter.authorizationStatus() == .authorized
    }

    /// Request speech recognition authorization if not yet determined.
    nonisolated func requestSpeechRecognitionAuthorization(completion: @escaping (Bool) -> Void) {
        let status = speechRecognizerAdapter.authorizationStatus()
        switch status {
        case .authorized:
            completion(true)
        case .notDetermined:
            speechRecognizerAdapter.requestAuthorization { newStatus in
                completion(newStatus == .authorized)
            }
        default:
            completion(false)
        }
    }

    // MARK: - Recording

    /// Pre-initialize the audio engine so the first recording starts instantly.
    /// Skips pre-warming when microphone permission hasn't been granted yet —
    /// accessing the input node triggers the system permission dialog, which we want to
    /// avoid on dev rebuilds (where TCC resets to `.notDetermined` after re-signing).
    func prewarmEngine() {
        guard !enginePrewarmed else { return }
        guard AVCaptureDevice.authorizationStatus(for: .audio) == .authorized else {
            log.info("Skipping audio engine pre-warm — microphone not yet authorized")
            return
        }
        engineController.prewarm()
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
        capturedPCMData = Data()

        // Reuse existing SFSpeechRecognizer across turns to avoid OS resource
        // release delays that make isAvailable return false on the second turn.
        // Recreate if transiently unavailable (e.g. after sleep/wake or heavy use).
        if speechRecognizer == nil || speechRecognizer?.isAvailable != true {
            speechRecognizer = speechRecognizerAdapter.makeRecognizer(locale: Locale(identifier: "en-US"))
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

        // Atomically validate format, install tap, and start engine.
        // Passes nil for format so AVAudioEngine uses its internal hardware
        // format, preventing sampleRate mismatch crashes.
        guard engineController.installTapAndStart(bufferSize: 4096, block: { [weak self] buffer, _ in
            guard let floatData = buffer.floatChannelData else { return }
            let frameCount = Int(buffer.frameLength)
            guard frameCount > 0 else { return }

            // Feed buffer to speech recognizer
            request.append(buffer)

            // Capture raw PCM for service STT: convert float32 to 16-bit PCM
            // and accumulate alongside the live recognizer path.
            let sampleRate = Int(buffer.format.sampleRate)
            var pcmChunk = Data(capacity: frameCount * MemoryLayout<Int16>.size)
            for i in 0..<frameCount {
                let clamped = max(-1.0, min(1.0, floatData[0][i]))
                let sample = Int16(clamped * Float(Int16.max))
                withUnsafeBytes(of: sample.littleEndian) { pcmChunk.append(contentsOf: $0) }
            }

            // Compute RMS for amplitude display and silence detection
            var sum: Float = 0
            for i in 0..<frameCount {
                let sample = floatData[0][i]
                sum += sample * sample
            }
            let rms = sqrt(sum / Float(frameCount))

            Task { @MainActor [weak self] in
                guard let self, self.isRecording else { return }

                // Accumulate PCM data for service STT
                self.capturedPCMData.append(pcmChunk)
                self.capturedSampleRate = sampleRate

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
        }) else {
            log.error("Failed to start audio engine for recording")
            tearDownRecognition()
            return false
        }

        isRecording = true
        lastSpeechTime = Date()
        recordingStartTime = Date()
        log.info("Recording started (SFSpeechRecognizer, onDevice: \(recognizer.supportsOnDeviceRecognition, privacy: .public))")
        return true
    }

    /// Stop recording and return the final transcription.
    ///
    /// Uses a service-first strategy: attempts STT via the gateway service with
    /// the captured WAV audio, falling back to the local SFSpeechRecognizer
    /// transcription when the service is unavailable or unconfigured.
    func stopRecordingAndGetTranscription() async -> String? {
        guard isRecording else { return nil }

        isRecording = false
        amplitude = 0

        engineController.stopAndRemoveTap()

        // Signal end of audio to the recognizer
        recognitionRequest?.endAudio()

        // Snapshot captured PCM and local recognizer text before async work
        let pcmData = capturedPCMData
        let sampleRate = capturedSampleRate
        capturedPCMData = Data()

        // Collect the local recognizer's best text (may be partial if final
        // callback hasn't fired yet).
        let localText = await resolveLocalTranscription()

        // Service-first: try the gateway STT service with captured audio
        let serviceText = await resolveServiceTranscription(pcmData: pcmData, sampleRate: sampleRate)

        tearDownRecognition()
        recordingStartTime = nil

        // Prefer service result, fall back to local recognizer
        let finalText = serviceText ?? localText
        log.info("Recording stopped, transcription: \(finalText ?? "<none>", privacy: .public) (source: \(serviceText != nil ? "service" : "local", privacy: .public))")
        return finalText
    }

    /// Resolve the local SFSpeechRecognizer transcription. Returns the current
    /// partial text immediately if available, otherwise waits briefly for the
    /// final recognition callback.
    private func resolveLocalTranscription() async -> String? {
        let currentText = latestTranscription.trimmingCharacters(in: .whitespacesAndNewlines)
        if !currentText.isEmpty {
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
        return result
    }

    /// Attempt STT transcription via the gateway service. Returns nil if the
    /// service is unconfigured, unavailable, or if no audio was captured.
    private func resolveServiceTranscription(pcmData: Data, sampleRate: Int) async -> String? {
        guard !pcmData.isEmpty else {
            log.info("STT service: no captured audio, skipping")
            return nil
        }

        let wavFormat = AudioWavEncoder.Format(sampleRate: sampleRate, channels: 1, bitsPerSample: 16)
        let wavData = await Task.detached(priority: .userInitiated) {
            AudioWavEncoder.encode(pcmData: pcmData, format: wavFormat)
        }.value

        let result = await sttClient.transcribe(audioData: wavData)
        switch result {
        case .success(let text):
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else {
                log.info("STT service: empty transcription, falling back to local")
                return nil
            }
            log.info("STT service: transcription succeeded (\(trimmed.count) chars)")
            return trimmed
        case .notConfigured:
            log.info("STT service: not configured, falling back to local recognizer")
            return nil
        case .serviceUnavailable:
            log.warning("STT service: unavailable, falling back to local recognizer")
            return nil
        case .error(let statusCode, let message):
            log.warning("STT service: error (HTTP \(statusCode ?? 0)): \(message), falling back to local recognizer")
            return nil
        }
    }

    /// Force stop recording without returning transcription.
    func cancelRecording() {
        guard isRecording else { return }
        isRecording = false
        amplitude = 0
        capturedPCMData = Data()
        engineController.stopAndRemoveTap()
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
        engineController.stop()
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

    // MARK: - Gateway TTS

    /// Called with each text delta — just accumulates text.
    func feedTextDelta(_ delta: String) {
        ttsTextBuffer += delta
    }

    /// Called when the full response is complete — sends accumulated text to the gateway TTS endpoint.
    func finishTextStream(onComplete: @escaping () -> Void) {
        let raw = ttsTextBuffer.trimmingCharacters(in: .whitespacesAndNewlines)
        let text = TTSRedactor.redact(raw)
        ttsTextBuffer = ""

        guard !text.isEmpty else {
            log.info("TTS: no text, completing immediately")
            onComplete()
            return
        }

        ttsOnComplete = onComplete
        startSpeakingAmplitudePolling()

        ttsTask = Task {
            guard !Task.isCancelled else { return }
            do {
                let result = await ttsClient.synthesizeText(text, context: "voice-mode", conversationId: conversationId)
                guard !Task.isCancelled else { return }

                switch result {
                case .success(let audioData):
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

                case .notConfigured:
                    log.info("TTS: provider not configured, completing immediately")

                case .featureDisabled:
                    log.info("TTS: feature disabled, completing immediately")

                case .notFound:
                    log.warning("TTS: endpoint returned not found")

                case .error(let statusCode, let message):
                    log.error("TTS endpoint error (HTTP \(statusCode ?? 0)): \(message)")
                }
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

    @ObservationIgnored private var bargeInMonitorActive = false

    /// Start monitoring the mic for speech during TTS playback.
    /// Uses a higher threshold than normal to avoid picking up speaker output.
    func startBargeInMonitor() {
        guard !bargeInMonitorActive else { return }
        bargeInMonitorActive = true

        // Atomically validate format, install tap, and start engine.
        // Passes nil for format so AVAudioEngine uses its internal hardware
        // format, preventing sampleRate mismatch crashes.
        if engineController.installTapAndStart(bufferSize: 4096, block: { [weak self] buffer, _ in
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
        }) {
            log.info("Barge-in monitor started")
        } else {
            log.error("Failed to start barge-in monitor")
            bargeInMonitorActive = false
        }
    }

    func stopBargeInMonitor() {
        guard bargeInMonitorActive else { return }
        bargeInMonitorActive = false
        engineController.stopAndRemoveTap()
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
