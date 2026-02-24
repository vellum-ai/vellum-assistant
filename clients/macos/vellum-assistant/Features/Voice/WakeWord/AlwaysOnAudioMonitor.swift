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

        // Install a tap using the hardware format for low-latency capture.
        // The buffer is available for the WakeWordEngine to consume via its
        // own internal processing (the engine's start() primes it for detection).
        inputNode.installTap(
            onBus: 0,
            bufferSize: Self.bufferSize,
            format: hwFormat
        ) { _, _ in
            // Audio frames are captured here. The WakeWordEngine processes
            // audio through its own pipeline once started. This tap keeps
            // the audio engine active and the input node flowing.
        }

        audioEngine.prepare()
        try audioEngine.start()
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
            isListening = false
        }
    }
}

// MARK: - Errors

enum AudioMonitorError: LocalizedError {
    case noInputChannels

    var errorDescription: String? {
        switch self {
        case .noInputChannels:
            return "No audio input channels available — microphone may not be connected or permitted"
        }
    }
}
