import Foundation
import Combine
import os

private let log = Logger(subsystem: "com.vellum.vellum-assistant", category: "WakeWordCoordinator")

/// Bridges wake word detection (AlwaysOnAudioMonitor) to voice mode activation (VoiceModeManager).
///
/// On wake word detected: pauses the audio monitor, ensures a ChatViewModel is available,
/// activates voice mode, and starts listening.
/// On voice mode deactivation: resumes passive wake word listening.
@MainActor
final class WakeWordCoordinator: ObservableObject {

    private let audioMonitor: AlwaysOnAudioMonitor
    private let voiceModeManager: VoiceModeManager
    private let threadManager: ThreadManager
    private weak var voiceInputManager: VoiceInputManager?

    /// When a wake word fires before the app is fully initialized,
    /// we queue it and process once `markReady()` is called.
    private var pendingWakeWord = false
    private var isReady = false

    private let activationWindow = WakeWordActivationWindow()
    private var stateCancellable: AnyCancellable?

    init(
        audioMonitor: AlwaysOnAudioMonitor,
        voiceModeManager: VoiceModeManager,
        threadManager: ThreadManager,
        voiceInputManager: VoiceInputManager? = nil
    ) {
        self.audioMonitor = audioMonitor
        self.voiceModeManager = voiceModeManager
        self.threadManager = threadManager
        self.voiceInputManager = voiceInputManager

        setupWakeWordHandler()
        observeVoiceModeState()
    }

    // MARK: - Readiness

    /// Call once the app is fully initialized (daemon connected, UI ready).
    /// Processes any wake word that fired before the app was ready.
    func markReady() {
        isReady = true
        if pendingWakeWord {
            pendingWakeWord = false
            log.info("Processing queued wake word after app became ready")
            handleWakeWordDetected()
        }
    }

    // MARK: - Wake Word Handling

    private func setupWakeWordHandler() {
        audioMonitor.onWakeWordDetected = { [weak self] in
            self?.onWakeWord()
        }
    }

    private func onWakeWord() {
        guard isReady else {
            log.info("Wake word detected before app ready — queuing")
            pendingWakeWord = true
            return
        }
        handleWakeWordDetected()
    }

    private func handleWakeWordDetected() {
        // Ignore if voice mode is already active
        guard voiceModeManager.state == .off else {
            log.info("Wake word ignored — voice mode already active (state: \(String(describing: voiceModeManager.state)))")
            return
        }

        // Ignore if PTT dictation is currently recording
        if let voiceInputManager, voiceInputManager.isRecording {
            log.info("Wake word ignored — PTT dictation is active")
            return
        }

        log.info("Wake word detected — activating voice mode")

        // 1. Play activation chime and show visual indicator
        WakeWordFeedback.playActivationChime()
        activationWindow.show(state: .activated)

        // 2. Pause the audio monitor (stop keyword listening to free the mic)
        audioMonitor.stopMonitoring()

        // 3. Ensure we have an active ChatViewModel (create a new thread if needed)
        let chatViewModel = ensureChatViewModel()

        // 4. Activate voice mode and start listening
        voiceModeManager.activate(chatViewModel: chatViewModel)
        voiceModeManager.startListening()
    }

    /// Returns the active ChatViewModel, creating a new thread if none exists.
    private func ensureChatViewModel() -> ChatViewModel {
        if let existing = threadManager.activeViewModel {
            return existing
        }
        // No active thread — create one, which sets it as active
        threadManager.createThread()
        // activeViewModel should now be set after createThread
        return threadManager.activeViewModel!
    }

    // MARK: - Voice Mode State Observation

    /// Watch VoiceModeManager.state — when it transitions to .off, resume the audio monitor.
    private func observeVoiceModeState() {
        stateCancellable = voiceModeManager.$state
            .removeDuplicates()
            .dropFirst() // skip the initial .off value
            .sink { [weak self] newState in
                guard let self else { return }
                if newState == .off {
                    log.info("Voice mode deactivated — resuming wake word listening")
                    WakeWordFeedback.playDeactivationChime()
                    self.activationWindow.show(state: .listening)
                    self.audioMonitor.startMonitoring()
                }
            }
    }
}
