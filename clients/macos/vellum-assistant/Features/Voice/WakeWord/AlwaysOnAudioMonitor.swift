import AVFoundation
import CoreAudio
import Foundation
import os

private let log = Logger(
    subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant",
    category: "AlwaysOnAudioMonitor"
)

/// Always-on audio monitor that continuously listens for a wake word using a
/// dedicated `AVAudioEngine` instance. Coexists with `VoiceInputManager` and
/// `OpenAIVoiceService`, each of which manage their own audio engines.
///
/// Installs an audio tap to capture PCM frames and coordinates with a
/// `WakeWordEngine` for keyword detection. Automatically restarts after
/// audio configuration changes (device connect/disconnect).
@MainActor
final class AlwaysOnAudioMonitor: ObservableObject {

    // MARK: - Public

    @Published private(set) var isListening = false

    /// Fired on the main actor when the wake word engine detects a keyword.
    var onWakeWordDetected: (() -> Void)?

    // MARK: - Private

    private let engine: WakeWordEngine
    private let audioEngine = AVAudioEngine()

    /// Small buffer size for low-latency wake word detection.
    private static let bufferSize: AVAudioFrameCount = 512

    private var configurationChangeObserver: NSObjectProtocol?

    // MARK: - Init

    init(engine: WakeWordEngine) {
        self.engine = engine
        setupEngineCallback()
        setupNotificationObservers()
    }

    deinit {
        if let observer = configurationChangeObserver {
            NotificationCenter.default.removeObserver(observer)
        }
        audioEngine.stop()
        audioEngine.inputNode.removeTap(onBus: 0)
        engine.stop()
    }

    // MARK: - Public API

    func startMonitoring() {
        guard !isListening else {
            log.info("Already listening, ignoring startMonitoring call")
            return
        }

        do {
            try engine.start()
        } catch {
            log.error("Wake word engine failed to start: \(error.localizedDescription)")
            return
        }

        do {
            try installTapAndStartAudio()
            isListening = true
            log.info("Audio monitoring started")
        } catch {
            log.error("Failed to start audio monitoring: \(error.localizedDescription)")
            engine.stop()
        }
    }

    func stopMonitoring() {
        guard isListening else { return }

        tearDownAudio()
        engine.stop()
        isListening = false
        log.info("Audio monitoring stopped")
    }

    // MARK: - Audio Setup

    private func installTapAndStartAudio() throws {
        let inputNode = audioEngine.inputNode
        let hwFormat = inputNode.outputFormat(forBus: 0)

        guard hwFormat.channelCount > 0 else {
            throw AudioMonitorError.noInputChannels
        }

        // Porcupine requires 16kHz mono Int16 PCM. Use hardware format for the tap
        // (avoids runtime assertions on some Macs) and resample in the callback.
        let targetFormat = AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: 16000,
            channels: 1,
            interleaved: false
        )!

        guard let converter = AVAudioConverter(from: hwFormat, to: targetFormat) else {
            throw AudioMonitorError.converterCreationFailed
        }

        inputNode.installTap(
            onBus: 0,
            bufferSize: Self.bufferSize,
            format: hwFormat
        ) { [weak self] buffer, _ in
            guard let self else { return }

            // Resample hardware audio to 16kHz mono
            let frameCapacity = AVAudioFrameCount(
                Double(buffer.frameLength) * targetFormat.sampleRate / hwFormat.sampleRate
            )
            guard let convertedBuffer = AVAudioPCMBuffer(
                pcmFormat: targetFormat,
                frameCapacity: frameCapacity
            ) else { return }

            var error: NSError?
            let status = converter.convert(to: convertedBuffer, error: &error) { _, outStatus in
                outStatus.pointee = .haveData
                return buffer
            }
            guard status == .haveData || status == .inputRanDry else { return }

            guard let floatData = convertedBuffer.floatChannelData else { return }
            let frameLength = Int(convertedBuffer.frameLength)
            var int16Samples = [Int16](repeating: 0, count: frameLength)
            for i in 0..<frameLength {
                let sample = max(-1.0, min(1.0, floatData[0][i]))
                int16Samples[i] = Int16(sample * Float(Int16.max))
            }
            self.engine.processAudioFrame(int16Samples)
        }

        audioEngine.prepare()
        do {
            try audioEngine.start()
        } catch {
            tearDownAudio()
            throw error
        }
    }

    private func tearDownAudio() {
        if audioEngine.isRunning {
            audioEngine.stop()
        }
        audioEngine.inputNode.removeTap(onBus: 0)
    }

    // MARK: - Wake Word Callback

    private func setupEngineCallback() {
        engine.onWakeWordDetected = { [weak self] confidence in
            // Dispatch to MainActor since the callback fires on a background thread.
            Task { @MainActor [weak self] in
                guard let self, self.isListening else { return }
                log.info("Wake word detected (confidence: \(confidence, format: .fixed(precision: 2)))")
                self.onWakeWordDetected?()
            }
        }
    }

    // MARK: - Audio Configuration Changes

    private func setupNotificationObservers() {
        // On macOS, AVAudioEngine posts this notification when the underlying
        // audio hardware configuration changes (device plugged/unplugged,
        // sample rate change, etc.). The engine stops automatically and must
        // be restarted.
        configurationChangeObserver = NotificationCenter.default.addObserver(
            forName: .AVAudioEngineConfigurationChange,
            object: audioEngine,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor [weak self] in
                self?.handleConfigurationChange()
            }
        }
    }

    private func handleConfigurationChange() {
        log.info("Audio configuration changed — restarting monitoring")
        guard isListening else { return }

        tearDownAudio()
        engine.stop()

        do {
            try engine.start()
            try installTapAndStartAudio()
            log.info("Audio monitoring restarted after configuration change")
        } catch {
            log.error("Failed to restart audio monitoring: \(error.localizedDescription)")
            engine.stop()
            isListening = false
        }
    }
}

// MARK: - Errors

enum AudioMonitorError: LocalizedError {
    case noInputChannels
    case converterCreationFailed

    var errorDescription: String? {
        switch self {
        case .noInputChannels:
            return "No audio input channels available — microphone may not be connected or permitted"
        case .converterCreationFailed:
            return "Failed to create audio format converter for 16kHz resampling"
        }
    }
}
