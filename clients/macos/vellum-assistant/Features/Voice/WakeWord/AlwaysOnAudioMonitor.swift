import AVFoundation
import Foundation
import os

private let log = Logger(
    subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant",
    category: "AlwaysOnAudioMonitor"
)

/// Always-on audio monitor that manages a `WakeWordEngine` for keyword
/// detection. The engine owns its own audio pipeline internally.
///
/// This class handles lifecycle (start/stop), the wake word callback,
/// and audio configuration change recovery.
@MainActor
final class AlwaysOnAudioMonitor: ObservableObject {

    // MARK: - Public

    @Published private(set) var isListening = false

    /// Fired on the main actor when the wake word engine detects a keyword.
    var onWakeWordDetected: (() -> Void)?

    // MARK: - Private

    private let engine: WakeWordEngine
    private var configurationChangeObserver: NSObjectProtocol?
    private var keywordObserver: NSObjectProtocol?

    // MARK: - Init

    init(engine: WakeWordEngine) {
        self.engine = engine
        setupEngineCallback()
        setupNotificationObservers()
        observeKeywordChanges()
    }

    deinit {
        if let observer = configurationChangeObserver {
            NotificationCenter.default.removeObserver(observer)
        }
        if let observer = keywordObserver {
            NotificationCenter.default.removeObserver(observer)
        }
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
            isListening = true
            log.info("Audio monitoring started")
        } catch {
            log.error("Wake word engine failed to start: \(error.localizedDescription)")
        }
    }

    func stopMonitoring() {
        guard isListening else { return }

        engine.stop()
        isListening = false
        log.info("Audio monitoring stopped")
    }

    // MARK: - Wake Word Callback

    private func setupEngineCallback() {
        engine.onWakeWordDetected = { [weak self] confidence in
            Task { @MainActor [weak self] in
                guard let self, self.isListening else { return }
                log.info("Wake word detected (confidence: \(confidence, format: .fixed(precision: 2)))")
                self.onWakeWordDetected?()
            }
        }
    }

    // MARK: - Audio Configuration Changes

    private func setupNotificationObservers() {
        configurationChangeObserver = NotificationCenter.default.addObserver(
            forName: .AVAudioEngineConfigurationChange,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor [weak self] in
                self?.handleConfigurationChange()
            }
        }
    }

    private func observeKeywordChanges() {
        keywordObserver = NotificationCenter.default.addObserver(
            forName: UserDefaults.didChangeNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self else { return }
                let newKeyword = UserDefaults.standard.string(forKey: "wakeWordKeyword") ?? "computer"
                self.engine.updateKeyword(newKeyword)
            }
        }
    }

    private func handleConfigurationChange() {
        log.info("Audio configuration changed — restarting monitoring")
        guard isListening else { return }

        engine.stop()

        do {
            try engine.start()
            log.info("Audio monitoring restarted after configuration change")
        } catch {
            log.error("Failed to restart audio monitoring: \(error.localizedDescription)")
            isListening = false
        }
    }
}
