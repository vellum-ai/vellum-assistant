import Foundation
import AVFoundation
import os

private let log = Logger(subsystem: "com.vellum.vellum-assistant", category: "OpenAIVoiceService")

enum OpenAIVoiceError: Error, LocalizedError {
    case noAPIKey
    case invalidResponse
    case apiError(statusCode: Int, message: String)
    case noAudioData

    var errorDescription: String? {
        switch self {
        case .noAPIKey: return "API key not configured"
        case .invalidResponse: return "Invalid API response"
        case .apiError(let code, let msg): return "API error (\(code)): \(msg)"
        case .noAudioData: return "No audio data recorded"
        }
    }
}

/// Voice service: Whisper STT (OpenAI) + TTS (ElevenLabs REST API).
/// Records audio, detects silence, transcribes via Whisper, speaks via ElevenLabs.
@MainActor
final class OpenAIVoiceService: ObservableObject {
    @Published var amplitude: Float = 0
    @Published var speakingAmplitude: Float = 0

    // MARK: - Recording State

    private let audioEngine = AVAudioEngine()
    private var rawPCMData = Data()
    private var recordingFormat: AVAudioFormat?
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

    private static let silenceThreshold: Float = 0.015
    private static let speechThreshold: Float = 0.025
    private static let silenceTimeout: TimeInterval = 1.0
    private static let minRecordingDuration: TimeInterval = 0.5

    // MARK: - ElevenLabs TTS State

    /// Accumulated text from streaming deltas — sent to ElevenLabs when response completes.
    private var ttsTextBuffer = ""
    private var ttsOnComplete: (() -> Void)?
    private var audioPlayer: AVAudioPlayer?
    private var speakingTimer: Timer?
    private var ttsTask: Task<Void, Never>?

    /// ElevenLabs voice ID — "Rachel" (clear, natural female voice).
    private static let elevenLabsVoiceId = "21m00Tcm4TlvDq8ikWAM"

    nonisolated init() {}

    // MARK: - API Keys

    var apiKey: String? { APIKeyManager.getKey(for: "openai") }
    var elevenLabsKey: String? { APIKeyManager.getKey(for: "elevenlabs") }
    var hasAPIKey: Bool { apiKey != nil }
    var hasElevenLabsKey: Bool { elevenLabsKey != nil }

    // MARK: - Recording

    /// Pre-initialize the audio engine so the first recording starts instantly.
    func prewarmEngine() {
        guard !enginePrewarmed else { return }
        let _ = audioEngine.inputNode
        audioEngine.prepare()
        enginePrewarmed = true
        log.info("Audio engine pre-warmed")
    }

    func startRecording() {
        guard !isRecording else { return }

        rawPCMData = Data()
        silenceHandled = false
        hasSpeechOccurred = false
        let inputNode = audioEngine.inputNode
        let format = inputNode.outputFormat(forBus: 0)

        guard format.channelCount > 0 else {
            log.error("No audio input channels")
            return
        }

        recordingFormat = format

        inputNode.installTap(onBus: 0, bufferSize: 4096, format: format) { [weak self] buffer, _ in
            guard let floatData = buffer.floatChannelData else { return }
            let frameCount = Int(buffer.frameLength)
            guard frameCount > 0 else { return }

            var chunk = Data(capacity: frameCount * 2)
            var sum: Float = 0
            for i in 0..<frameCount {
                let sample = floatData[0][i]
                let clamped = max(-1.0, min(1.0, sample))
                var int16 = Int16(clamped * Float(Int16.max))
                withUnsafeBytes(of: &int16) { chunk.append(contentsOf: $0) }
                sum += sample * sample
            }
            let rms = sqrt(sum / Float(frameCount))

            Task { @MainActor [weak self] in
                guard let self, self.isRecording else { return }
                self.rawPCMData.append(chunk)
                self.amplitude = min(rms * 5, 1.0)

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
            log.info("Recording started")
        } catch {
            log.error("Failed to start audio engine: \(error.localizedDescription)")
            audioEngine.inputNode.removeTap(onBus: 0)
            recordingFormat = nil
        }
    }

    /// Stop recording and return the audio data as WAV.
    func stopRecordingAndGetAudio() -> Data? {
        guard isRecording else { return nil }

        isRecording = false
        amplitude = 0

        if audioEngine.isRunning {
            audioEngine.stop()
            audioEngine.inputNode.removeTap(onBus: 0)
        }

        guard let format = recordingFormat, !rawPCMData.isEmpty else {
            log.warning("No audio data recorded")
            return nil
        }

        let wavData = createWAV(pcmData: rawPCMData, sampleRate: UInt32(format.sampleRate))
        rawPCMData = Data()
        recordingFormat = nil
        recordingStartTime = nil

        log.info("Recording stopped, WAV size: \(wavData.count) bytes")
        return wavData
    }

    /// Force stop recording without returning audio data.
    func cancelRecording() {
        guard isRecording else { return }
        isRecording = false
        amplitude = 0
        if audioEngine.isRunning {
            audioEngine.stop()
            audioEngine.inputNode.removeTap(onBus: 0)
        }
        rawPCMData = Data()
        recordingFormat = nil
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
        enginePrewarmed = false
        log.info("Audio engine shut down")
    }

    // MARK: - Whisper STT

    func transcribe(_ audioData: Data) async throws -> String {
        guard let apiKey else {
            throw OpenAIVoiceError.noAPIKey
        }

        let url = URL(string: "https://api.openai.com/v1/audio/transcriptions")!
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        request.timeoutInterval = 30

        let boundary = UUID().uuidString
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")

        var body = Data()
        body.append(contentsOf: "--\(boundary)\r\n".utf8)
        body.append(contentsOf: "Content-Disposition: form-data; name=\"file\"; filename=\"audio.wav\"\r\n".utf8)
        body.append(contentsOf: "Content-Type: audio/wav\r\n\r\n".utf8)
        body.append(audioData)
        body.append(contentsOf: "\r\n".utf8)
        body.append(contentsOf: "--\(boundary)\r\n".utf8)
        body.append(contentsOf: "Content-Disposition: form-data; name=\"model\"\r\n\r\n".utf8)
        body.append(contentsOf: "whisper-1\r\n".utf8)
        body.append(contentsOf: "--\(boundary)--\r\n".utf8)

        request.httpBody = body

        let (data, response) = try await URLSession.shared.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse else {
            throw OpenAIVoiceError.invalidResponse
        }

        guard httpResponse.statusCode == 200 else {
            let errorBody = String(data: data, encoding: .utf8) ?? "Unknown error"
            log.error("Whisper API error (\(httpResponse.statusCode)): \(errorBody)")
            throw OpenAIVoiceError.apiError(statusCode: httpResponse.statusCode, message: errorBody)
        }

        struct WhisperResponse: Decodable { let text: String }
        let result = try JSONDecoder().decode(WhisperResponse.self, from: data)
        log.info("Whisper transcription: \(result.text, privacy: .public)")
        return result.text
    }

    // MARK: - ElevenLabs TTS (REST API)

    /// Called with each text delta — just accumulates text.
    func feedTextDelta(_ delta: String) {
        ttsTextBuffer += delta
    }

    /// Called when the full response is complete — sends accumulated text to ElevenLabs.
    func finishTextStream(onComplete: @escaping () -> Void) {
        let text = ttsTextBuffer.trimmingCharacters(in: .whitespacesAndNewlines)
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
            throw OpenAIVoiceError.noAPIKey
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
            throw OpenAIVoiceError.invalidResponse
        }

        guard httpResponse.statusCode == 200 else {
            let errorBody = String(data: data, encoding: .utf8) ?? "Unknown error"
            log.error("ElevenLabs API error (\(httpResponse.statusCode)): \(errorBody)")
            throw OpenAIVoiceError.apiError(statusCode: httpResponse.statusCode, message: errorBody)
        }

        guard !data.isEmpty else {
            throw OpenAIVoiceError.noAudioData
        }

        return data
    }

    // MARK: - Speaking Amplitude

    private func startSpeakingAmplitudePolling() {
        speakingTimer = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self, self.audioPlayer?.isPlaying == true else { return }
                self.speakingAmplitude = Float.random(in: 0.3...0.8)
            }
        }
    }

    private func stopSpeakingAmplitudePolling() {
        speakingTimer?.invalidate()
        speakingTimer = nil
    }

    // MARK: - WAV Encoding

    private func createWAV(pcmData: Data, sampleRate: UInt32) -> Data {
        let numChannels: UInt16 = 1
        let bitsPerSample: UInt16 = 16
        let bytesPerSample = bitsPerSample / 8
        let dataSize = UInt32(pcmData.count)

        var wav = Data(capacity: 44 + pcmData.count)
        wav.append(contentsOf: "RIFF".utf8)
        appendLE(&wav, 36 + dataSize)
        wav.append(contentsOf: "WAVE".utf8)
        wav.append(contentsOf: "fmt ".utf8)
        appendLE(&wav, UInt32(16))
        appendLE(&wav, UInt16(1)) // PCM
        appendLE(&wav, numChannels)
        appendLE(&wav, sampleRate)
        appendLE(&wav, sampleRate * UInt32(numChannels) * UInt32(bytesPerSample))
        appendLE(&wav, numChannels * bytesPerSample)
        appendLE(&wav, bitsPerSample)
        wav.append(contentsOf: "data".utf8)
        appendLE(&wav, dataSize)
        wav.append(pcmData)
        return wav
    }

    private func appendLE(_ data: inout Data, _ value: UInt32) {
        var v = value.littleEndian
        withUnsafeBytes(of: &v) { data.append(contentsOf: $0) }
    }

    private func appendLE(_ data: inout Data, _ value: UInt16) {
        var v = value.littleEndian
        withUnsafeBytes(of: &v) { data.append(contentsOf: $0) }
    }
}
