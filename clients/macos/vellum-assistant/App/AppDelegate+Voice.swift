import AppKit
import Combine
import VellumAssistantShared
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "AppDelegate")

// MARK: - Voice Input

extension AppDelegate {

    func setupVoiceInput() {
        voiceInput = VoiceInputManager()
        voiceInput?.onTranscription = { [weak self] text in
            self?.voiceTranscriptionWindow?.close()
            self?.voiceTranscriptionWindow = nil

            // Capture prefix before clearing — it was saved when partials started
            let savedPrefix = (self?.preVoiceInputText ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            self?.preVoiceInputText = nil

            // PTT uses priority-based routing because it's a one-shot dictation: the user
            // speaks a single utterance and expects it to go to whatever surface is currently
            // focused.
            // Priority 0: Route to quick input bar if visible
            if let quickInput = self?.quickInputWindow, quickInput.isVisible {
                quickInput.setVoiceText(text)
                return
            }

            // Priority 1: Route to main window ChatView if in the foreground
            if NSApp.isActive,
               let mainWindow = self?.mainWindow, mainWindow.isVisible,
               let viewModel = mainWindow.activeViewModel {
                // Append transcribed text to any existing input — let the user send manually
                viewModel.inputText = savedPrefix.isEmpty ? text : "\(savedPrefix) \(text)"
                return
            }

            // Priority 2: Fall back to creating a new session
            self?.startSession(task: text, source: "voice")
        }
        voiceInput?.onPartialTranscription = { [weak self] text in
            // Skip if recording already stopped (late callback from speech recognizer)
            guard self?.voiceInput?.isRecording == true else { return }

            // Priority 0: Route partial text to quick input bar if visible
            if let quickInput = self?.quickInputWindow, quickInput.isVisible {
                quickInput.setVoiceText(text)
                return
            }

            // Priority 1: Route partial text to main window ChatView input if in the foreground
            if NSApp.isActive,
               let mainWindow = self?.mainWindow, mainWindow.isVisible,
               let viewModel = mainWindow.activeViewModel {
                // Capture existing text on first partial so we can prepend it
                if self?.preVoiceInputText == nil {
                    self?.preVoiceInputText = viewModel.inputText.trimmingCharacters(in: .whitespacesAndNewlines)
                }
                let prefix = self?.preVoiceInputText ?? ""
                viewModel.inputText = prefix.isEmpty ? text : "\(prefix) \(text)"
                return
            }
        }
        voiceInput?.onActionModeTriggered = { [weak self] text in
            guard let self else { return }
            log.info("Action mode triggered from voice dictation — submitting task")
            self.startSession(task: text, source: "voice_action")
        }
        voiceInput?.onAmplitudeChanged = { [weak self] amplitude in
            // Lazy-acquire recordingViewModel if it wasn't set during onRecordingStateChanged
            // (can happen when dictation starts before the view model lookup resolves).
            if self?.recordingViewModel == nil {
                self?.recordingViewModel = self?.mainWindow?.activeViewModel
            }
            self?.recordingViewModel?.recordingAmplitude = amplitude
        }
        voiceInput?.onRecordingStateChanged = { [weak self] isRecording in
            // Check if main window is actively in the foreground (not just existing behind other apps)
            let mainWindowActive = NSApp.isActive && (self?.mainWindow?.isVisible ?? false)

            // Sync recording state: clear on the view model that started recording
            // to avoid stale isRecording when the user switches conversations mid-recording.
            if isRecording {
                self?.recordingViewModel = self?.mainWindow?.activeViewModel
            }
            if let vm = self?.recordingViewModel {
                vm.isRecording = isRecording
            }
            if !isRecording {
                self?.recordingViewModel?.recordingAmplitude = 0
                self?.recordingViewModel = nil
            }

            // Sync recording state to the quick input bar
            self?.quickInputWindow?.setRecordingState(isRecording)

            if isRecording {
                self?.statusItem.button?.image = NSImage(
                    systemSymbolName: "mic.fill",
                    accessibilityDescription: "Vellum"
                )
                let quickInputActive = self?.quickInputWindow?.isVisible ?? false
                let isDictation = self?.voiceInput?.currentMode == .dictation
                let isChatComposerOrigin = self?.voiceInput?.activeOrigin == .chatComposer
                if !mainWindowActive && !quickInputActive && !isDictation && !isChatComposerOrigin,
                   let manager = self?.mainWindow?.voiceModeManager {
                    let window = VoiceTranscriptionWindow(voiceModeManager: manager)
                    window.show()
                    self?.voiceTranscriptionWindow = window
                }
            } else {
                self?.voiceTranscriptionWindow?.close()
                self?.voiceTranscriptionWindow = nil
                self?.updateMenuBarIcon()
            }
        }
        voiceInput?.start()

        // Restart key monitors when the activation key is changed remotely via HTTP
        NotificationCenter.default.addObserver(
            forName: .activationKeyChanged,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in
                self?.voiceInput?.restartKeyMonitors()
            }
        }
    }

    // MARK: - Ambient Agent

    func setupAmbientAgent() {
        ambientAgent.appDelegate = self
        ambientAgent.daemonClient = daemonClient
    }

    func updateMenuBarIcon() {
        guard statusItem != nil, let button = statusItem.button else { return }
        configureMenuBarIcon(button)
    }
}
