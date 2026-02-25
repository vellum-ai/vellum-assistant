import Foundation
import Combine
import VellumAssistantShared
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
    private let windowState: MainWindowState
    private weak var voiceInputManager: VoiceInputManager?

    /// When a wake word fires before the app is fully initialized,
    /// we queue it and process once `markReady()` is called.
    private var pendingWakeWord = false
    private var isReady = false
    private var activatedViaWakeWord = false

    private let activationWindow = WakeWordActivationWindow()
    private var stateCancellable: AnyCancellable?

    /// Cooldown after activation to prevent re-triggering from leftover audio.
    private var lastActivationTime: Date?
    private static let activationCooldown: TimeInterval = 3.0

    init(
        audioMonitor: AlwaysOnAudioMonitor,
        voiceModeManager: VoiceModeManager,
        threadManager: ThreadManager,
        windowState: MainWindowState,
        voiceInputManager: VoiceInputManager? = nil
    ) {
        self.audioMonitor = audioMonitor
        self.voiceModeManager = voiceModeManager
        self.threadManager = threadManager
        self.windowState = windowState
        self.voiceInputManager = voiceInputManager

        setupWakeWordHandler()
        observeVoiceModeState()
        observeVoiceInputRecording()
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
        // Ignore if wake word is disabled in settings
        guard UserDefaults.standard.bool(forKey: "wakeWordEnabled") else { return }

        // Ignore if voice mode is already active
        guard voiceModeManager.state == .off else {
            log.info("Wake word ignored — voice mode already active (state: \(String(describing: self.voiceModeManager.state)))")
            return
        }

        // Ignore if PTT dictation is currently recording
        if let voiceInputManager, voiceInputManager.isRecording {
            log.info("Wake word ignored — PTT dictation is active")
            return
        }

        // Cooldown to prevent re-triggering from leftover audio after activation
        if let lastActivation = lastActivationTime,
           Date().timeIntervalSince(lastActivation) < Self.activationCooldown {
            log.info("Wake word ignored — within cooldown period")
            return
        }

        log.info("Wake word detected — activating voice mode")
        lastActivationTime = Date()

        // 1. Play activation chime and show visual indicator
        WakeWordFeedback.playActivationChime()
        activationWindow.show(state: .activated)

        // 2. Pause the audio monitor (stop keyword listening to free the mic)
        audioMonitor.stopMonitoring()

        // 3. Ensure we have an active ChatViewModel (create a new thread if needed)
        let chatViewModel = ensureChatViewModel()

        // 4. Show voice mode panel and activate (same as the UI button)
        windowState.selection = .panel(.voiceMode)
        voiceModeManager.activate(chatViewModel: chatViewModel)
        guard voiceModeManager.state != .off else {
            log.warning("Voice mode activation failed — resuming wake word listening")
            windowState.selection = nil
            audioMonitor.startMonitoring()
            return
        }
        activatedViaWakeWord = true
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

    // MARK: - PTT Recording Observation

    /// macOS only allows one active SFSpeechRecognitionTask per process.
    /// When VoiceInputManager starts PTT recording, pause the wake word
    /// engine to avoid conflicts. Resume when recording stops.
    private func observeVoiceInputRecording() {
        guard let voiceInputManager else { return }

        // Chain onto the existing callback rather than replacing it
        let existingCallback = voiceInputManager.onRecordingStateChanged
        voiceInputManager.onRecordingStateChanged = { [weak self, existingCallback] isRecording in
            existingCallback?(isRecording)
            guard let self else { return }
            guard UserDefaults.standard.bool(forKey: "wakeWordEnabled") else { return }
            guard self.audioMonitor.isListening || isRecording else { return }

            if isRecording {
                log.info("PTT recording started — pausing wake word engine")
                self.audioMonitor.stopMonitoring()
            } else {
                // Only resume if voice mode isn't active (voice mode has its own resume logic)
                guard self.voiceModeManager.state == .off else { return }
                log.info("PTT recording stopped — resuming wake word engine")
                self.audioMonitor.startMonitoring()
            }
        }
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
                    // Only resume monitoring if wake word is enabled in settings
                    if UserDefaults.standard.bool(forKey: "wakeWordEnabled") {
                        log.info("Voice mode deactivated — resuming wake word listening after delay")
                        if self.activatedViaWakeWord {
                            WakeWordFeedback.playDeactivationChime()
                            self.activationWindow.show(state: .listening)
                        }
                        // Delay to let voice mode's audio engine fully release the mic
                        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [weak self] in
                            guard let self else { return }
                            guard self.voiceModeManager.state == .off else { return }
                            self.audioMonitor.startMonitoring()
                        }
                    }
                    self.activatedViaWakeWord = false  // always reset, regardless of setting
                } else if self.audioMonitor.isListening {
                    // Voice mode activated (via button or other path) — stop wake word
                    // engine so it doesn't compete for the microphone.
                    log.info("Voice mode activated externally — pausing wake word engine")
                    self.audioMonitor.stopMonitoring()
                }
            }
    }
}
