import Foundation
import AppKit
import Speech
import AVFoundation
import os
import VellumAssistantShared

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "VoiceInput")

/// Determines how voice transcriptions are routed after speech recognition completes.
enum VoiceInputMode {
    case conversation  // existing behavior — transcription goes to chat
    case dictation     // transcription goes to daemon for cleanup, then inserted at cursor
}

@MainActor
final class VoiceInputManager {
    var onTranscription: ((String) -> Void)?
    var onPartialTranscription: ((String) -> Void)?
    var onRecordingStateChanged: ((Bool) -> Void)?

    /// Controls how completed transcriptions are routed. Defaults to `.dictation` so
    /// voice input goes through the daemon cleanup path for cursor insertion.
    var currentMode: VoiceInputMode = .dictation

    /// Daemon client used to send dictation requests in `.dictation` mode.
    var daemonClient: DaemonClient?

    /// Called when the daemon returns a dictation response (cleaned-up text + action plan).
    var onDictationResponse: ((IPCDictationResponse) -> Void)?

    /// Called when the daemon classifies dictation as an action (e.g. "Slack Alex about the standup").
    /// The callback receives the original transcription text for routing to a full agent session.
    var onActionModeTriggered: ((String) -> Void)?

    /// Context captured at activation time, describing the frontmost app state.
    private var currentDictationContext: DictationContext?

    /// Floating overlay showing dictation state (recording/processing/done).
    private let overlayWindow = DictationOverlayWindow()

    /// Overlay for first-use permission prompts (microphone/speech recognition).
    private let permissionOverlay = PermissionPromptOverlay()

    /// True after a dictation request has been sent to the daemon and we're awaiting a response.
    /// Used by `stopRecording()` to decide whether the overlay should stay visible.
    private var awaitingDaemonResponse = false

    /// Whether the microphone is currently recording for PTT/dictation.
    private(set) var isRecording = false
    private var globalMonitor: Any?
    private var localMonitor: Any?
    private var globalKeyDownMonitor: Any?
    private var localKeyDownMonitor: Any?
    private var holdTask: Task<Void, Never>?
    private var otherKeyPressedDuringHold = false  // True if any other key pressed while holding
    private static let holdDelay: UInt64 = 300_000_000 // 300ms in nanoseconds
    private var lastAppSwitchTime: Date = .distantPast
    private var appSwitchObservers: [Any] = []

    private var activationFlags: NSEvent.ModifierFlags? {
        let stored = UserDefaults.standard.string(forKey: "activationKey") ?? "fn"
        switch stored {
        case "ctrl": return .control
        case "fn_shift": return [.function, .shift]
        case "none": return nil
        default: return .function // fn and globe are the same physical key
        }
    }

    private let speechRecognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private let audioEngine = AVAudioEngine()

    /// Exposes the audio engine for amplitude tracking in voice mode.
    var exposedAudioEngine: AVAudioEngine { audioEngine }

    func start() {
        setupFnKeyMonitors()

        // Cancel any in-flight hold when the user switches apps, to prevent the
        // microphone from activating accidentally during Cmd+Tab / Ctrl+Space etc.
        // System keyboard shortcuts consume their .keyDown events before global
        // monitors see them, so otherKeyPressedDuringHold never fires — making
        // these notifications the only reliable signal for an app switch in progress.
        let workspaceObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            guard let self else { return }
            self.lastAppSwitchTime = Date()
            self.holdTask?.cancel()
            self.holdTask = nil
            self.otherKeyPressedDuringHold = false
        }
        let resignObserver = NotificationCenter.default.addObserver(
            forName: NSApplication.didResignActiveNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            guard let self else { return }
            self.lastAppSwitchTime = Date()
            self.holdTask?.cancel()
            self.holdTask = nil
            self.otherKeyPressedDuringHold = false
        }
        appSwitchObservers = [workspaceObserver, resignObserver]

        // Wire the dictation response callback to insert text and manage the overlay
        if onDictationResponse == nil {
            onDictationResponse = { [weak self] response in
                self?.handleDictationResponse(text: response.text, mode: response.mode)
            }
        }
    }

    /// Tear down and re-create key monitors so changes to the activation key
    /// take effect immediately without restarting the app.
    func restartKeyMonitors() {
        stop()
        start()
    }

    func stop() {
        if let monitor = globalMonitor {
            NSEvent.removeMonitor(monitor)
            globalMonitor = nil
        }
        if let monitor = localMonitor {
            NSEvent.removeMonitor(monitor)
            localMonitor = nil
        }
        if let monitor = globalKeyDownMonitor {
            NSEvent.removeMonitor(monitor)
            globalKeyDownMonitor = nil
        }
        if let monitor = localKeyDownMonitor {
            NSEvent.removeMonitor(monitor)
            localKeyDownMonitor = nil
        }
        for observer in appSwitchObservers {
            NSWorkspace.shared.notificationCenter.removeObserver(observer)
            NotificationCenter.default.removeObserver(observer)
        }
        appSwitchObservers = []
        stopRecording()
        overlayWindow.dismiss()
        permissionOverlay.dismiss()
    }

    /// Directly toggle recording on/off — used by UI mic buttons that bypass the Fn-key hold flow.
    func toggleRecording() {
        if isRecording {
            stopRecording()
        } else {
            beginRecording()
        }
    }

    // MARK: - Continuous Recording (Voice Mode)

    /// Start recording without requiring a key hold. Used by voice mode for hands-free operation.
    func startContinuousRecording() {
        guard !isRecording else { return }
        beginRecording()
    }

    /// Stop continuous recording. Unlike `stopRecording()`, this does NOT cancel
    /// the recognition task — it stops audio input and calls `endAudio()` so the
    /// recognizer produces an `isFinal` result via the callback, which then
    /// triggers `onTranscription` and cleans up.
    func stopContinuousRecording() {
        guard isRecording else { return }
        log.info("Stopping continuous recording — waiting for final transcription")

        audioEngine.stop()
        audioEngine.inputNode.removeTap(onBus: 0)

        // Signal end of audio — the recognizer will process remaining audio
        // and fire the callback with isFinal = true.
        recognitionRequest?.endAudio()
    }

    // MARK: - Fn Key Detection

    private func setupFnKeyMonitors() {
        globalMonitor = NSEvent.addGlobalMonitorForEvents(matching: .flagsChanged) { [weak self] event in
            Task { @MainActor in
                self?.handleFlagsChanged(event)
            }
        }
        localMonitor = NSEvent.addLocalMonitorForEvents(matching: .flagsChanged) { [weak self] event in
            Task { @MainActor in
                self?.handleFlagsChanged(event)
            }
            return event
        }

        // Monitor keyDown events to detect when user types while holding activation key
        // (e.g., Control+C, Control+Z) and cancel voice activation in those cases.
        globalKeyDownMonitor = NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { [weak self] _ in
            Task { @MainActor in
                self?.handleKeyDown()
            }
        }
        localKeyDownMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            Task { @MainActor in
                self?.handleKeyDown()
            }
            return event
        }
    }

    private func handleFlagsChanged(_ event: NSEvent) {
        guard let requiredFlags = activationFlags else { return }
        let keyPressed = event.modifierFlags.contains(requiredFlags)
        var otherModifiers: NSEvent.ModifierFlags = [.command, .shift, .control, .option, .function]
        for flag in [NSEvent.ModifierFlags.command, .shift, .control, .option, .function] {
            if requiredFlags.contains(flag) {
                otherModifiers.remove(flag)
            }
        }
        let hasOtherModifiers = !event.modifierFlags.intersection(otherModifiers).isEmpty

        if keyPressed && !hasOtherModifiers && !isRecording {
            // Activation key(s) pressed alone - start timer to begin recording while held
            holdTask?.cancel()
            otherKeyPressedDuringHold = false
            // Skip if an app switch happened recently — this Fn/Ctrl press is likely
            // from a system keyboard shortcut (Cmd+Tab, Ctrl+arrows) used to switch apps.
            guard Date().timeIntervalSince(lastAppSwitchTime) > 0.5 else { return }
            holdTask = Task { [weak self] in
                try? await Task.sleep(nanoseconds: Self.holdDelay)
                guard !Task.isCancelled else { return }
                guard let self = self else { return }
                // Don't start recording if any key was pressed during hold (Control+C, etc.)
                guard !self.otherKeyPressedDuringHold else { return }
                guard Date().timeIntervalSince(self.lastAppSwitchTime) > 0.5 else { return }
                // Capture frontmost app context before recording starts so the daemon
                // knows where to insert the cleaned-up text after dictation completes.
                if self.currentMode == .dictation {
                    self.currentDictationContext = DictationContextCapture.capture()
                }
                self.beginRecording()
            }
        } else if keyPressed && hasOtherModifiers {
            // Another modifier pressed - cancel voice activation
            holdTask?.cancel()
            holdTask = nil
        } else if !keyPressed {
            // Activation key released
            holdTask?.cancel()
            holdTask = nil
            if isRecording {
                if currentMode == .dictation {
                    // In dictation mode, don't cancel the recognition — let it finish
                    // processing and deliver the final transcription via the callback.
                    stopRecordingForDictation()
                } else {
                    stopRecording()
                }
            }
        }
    }

    private func handleKeyDown() {
        // If user types any key while holding the activation modifier (e.g. Control+C),
        // set flag to prevent recording and cancel timer for immediate feedback
        otherKeyPressedDuringHold = true
        holdTask?.cancel()
        holdTask = nil
    }

    // MARK: - Recording

    private func beginRecording() {
        guard let speechRecognizer = speechRecognizer, speechRecognizer.isAvailable else {
            log.error("Speech recognizer not available")
            currentDictationContext = nil
            return
        }

        // Don't start if a previous recognition task is still processing
        if recognitionTask != nil {
            log.warning("Previous recognition task still active, skipping")
            currentDictationContext = nil
            return
        }

        // Check microphone and speech permissions before recording.
        // Show an informative overlay for first-use or denied states instead of
        // silently opening System Settings.
        let micStatus = AVCaptureDevice.authorizationStatus(for: .audio)
        let speechStatus = SFSpeechRecognizer.authorizationStatus()

        if micStatus == .notDetermined || speechStatus == .notDetermined {
            showPermissionPrompt(kind: .notDetermined)
            currentDictationContext = nil
            return
        }
        let micDenied = micStatus == .denied || micStatus == .restricted
        let speechDenied = speechStatus == .denied || speechStatus == .restricted
        if micDenied || speechDenied {
            let deniedPermission: PermissionPromptOverlay.DeniedPermission
            if micDenied && speechDenied {
                deniedPermission = .both
            } else if micDenied {
                deniedPermission = .microphone
            } else {
                deniedPermission = .speechRecognition
            }
            showPermissionPrompt(kind: .denied, deniedPermission: deniedPermission)
            currentDictationContext = nil
            return
        }

        isRecording = true
        onRecordingStateChanged?(true)
        if currentMode == .dictation {
            overlayWindow.show(state: .recording)
        }
        log.info("Voice recording started")

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        recognitionRequest = request

        let inputNode = audioEngine.inputNode
        let recordingFormat = inputNode.outputFormat(forBus: 0)

        guard recordingFormat.channelCount > 0 else {
            log.error("No audio input channels available")
            isRecording = false
            onRecordingStateChanged?(false)
            currentDictationContext = nil
            recognitionRequest = nil
            overlayWindow.dismiss()
            return
        }

        inputNode.installTap(onBus: 0, bufferSize: 1024, format: recordingFormat) { buffer, _ in
            request.append(buffer)
        }

        recognitionTask = speechRecognizer.recognitionTask(with: request) { [weak self] result, error in
            Task { @MainActor in
                guard let self = self else { return }
                // Ignore late callbacks delivered after recording was stopped
                // (e.g. endAudio() triggering a delayed isFinal via Task dispatch).
                guard self.isRecording else { return }

                if let result = result {
                    let text = result.bestTranscription.formattedString
                    if result.isFinal {
                        log.info("Transcription: \(text, privacy: .public)")
                        if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                            self.handleFinalTranscription(text)
                        }
                        self.recognitionTask = nil
                        self.stopRecording()
                    } else {
                        self.onPartialTranscription?(text)
                    }
                }

                if let error = error {
                    log.error("Recognition error: \(error.localizedDescription)")
                    self.recognitionTask = nil
                    self.stopRecording()
                }
            }
        }

        do {
            audioEngine.prepare()
            try audioEngine.start()
        } catch {
            log.error("Audio engine failed to start: \(error.localizedDescription)")
            isRecording = false
            onRecordingStateChanged?(false)
            recognitionRequest?.endAudio()
            recognitionRequest = nil
            recognitionTask?.cancel()
            recognitionTask = nil
            currentDictationContext = nil
            audioEngine.inputNode.removeTap(onBus: 0)
            overlayWindow.dismiss()
        }
    }

    // MARK: - Permission Prompt

    /// Possible permission states that trigger a prompt overlay.
    private enum PermissionPromptKind {
        case notDetermined
        case denied
    }

    /// Display name for the currently configured activation key, for use in user-facing copy.
    private var activationKeyDisplayName: String {
        let stored = UserDefaults.standard.string(forKey: "activationKey") ?? "fn"
        switch stored {
        case "ctrl": return "ctrl"
        case "fn_shift": return "fn + shift"
        case "none": return "the activation key"
        default: return "fn"
        }
    }

    /// Show the permission prompt overlay explaining why access is needed and providing
    /// action buttons. After the user grants access, recording starts automatically.
    private func showPermissionPrompt(
        kind: PermissionPromptKind,
        deniedPermission: PermissionPromptOverlay.DeniedPermission = .both
    ) {
        let keyName = activationKeyDisplayName

        switch kind {
        case .notDetermined:
            permissionOverlay.show(
                kind: .notDetermined(keyName: keyName),
                onGrantAccess: { [weak self] in
                    Task { @MainActor [weak self] in
                        guard let self = self else { return }
                        await self.requestPermissionsAndRecord()
                    }
                },
                onDismiss: { [weak self] in
                    log.info("User dismissed permission prompt")
                    self?.permissionOverlay.dismiss()
                }
            )

        case .denied:
            permissionOverlay.show(
                kind: .denied(keyName: keyName, deniedPermission: deniedPermission),
                onGrantAccess: { },
                onDismiss: { [weak self] in
                    self?.permissionOverlay.dismiss()
                }
            )
        }
    }

    /// Request both microphone and speech recognition permissions sequentially,
    /// then start recording if both are granted.
    private func requestPermissionsAndRecord() async {
        let micGranted = await AVCaptureDevice.requestAccess(for: .audio)
        guard micGranted else {
            log.warning("Microphone access denied by user")
            showPermissionPrompt(kind: .denied, deniedPermission: .microphone)
            return
        }

        let speechGranted = await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { status in
                continuation.resume(returning: status == .authorized)
            }
        }
        guard speechGranted else {
            log.warning("Speech recognition access denied by user")
            showPermissionPrompt(kind: .denied, deniedPermission: .speechRecognition)
            return
        }

        log.info("Permissions granted — starting recording")
        if self.currentMode == .dictation {
            self.currentDictationContext = DictationContextCapture.capture()
        }
        self.beginRecording()
    }

    private func openPrivacySettings(for pane: String) {
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?\(pane)") {
            NSWorkspace.shared.open(url)
        }
    }

    /// Routes a final transcription based on the current mode.
    private func handleFinalTranscription(_ text: String) {
        switch currentMode {
        case .conversation:
            onTranscription?(text)
        case .dictation:
            guard let context = currentDictationContext else {
                // No context captured (e.g. continuous recording path) — fall back to conversation
                onTranscription?(text)
                return
            }
            let request = IPCDictationRequest(
                transcription: text,
                context: .create(
                    bundleIdentifier: context.bundleIdentifier,
                    appName: context.appName,
                    windowTitle: context.windowTitle,
                    selectedText: context.selectedText,
                    cursorInTextField: context.cursorInTextField
                )
            )
            if let selected = context.selectedText, !selected.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                overlayWindow.show(state: .transforming(text))
            } else {
                overlayWindow.show(state: .processing)
            }
            do {
                guard let client = daemonClient else {
                    throw NSError(domain: "VoiceInput", code: 1, userInfo: [NSLocalizedDescriptionKey: "Daemon client unavailable"])
                }
                try client.send(request)
                awaitingDaemonResponse = true
                log.info("Sent dictation_request to daemon for app=\(context.appName, privacy: .public)")
            } catch {
                log.error("Failed to send dictation_request: \(error.localizedDescription)")
                overlayWindow.dismiss()
                onTranscription?(text)
            }
        }
    }

    /// Handle the daemon's dictation response — insert cleaned text or route action mode to a task.
    func handleDictationResponse(text: String, mode: String) {
        awaitingDaemonResponse = false
        if mode == "dictation" || mode == "command" {
            DictationTextInserter.insertText(text)
            overlayWindow.showDoneAndDismiss()
        } else if mode == "action" {
            overlayWindow.dismiss()
            log.info("Action mode detected — routing transcription to task submission: \(text, privacy: .public)")
            onActionModeTriggered?(text)
        }
    }

    /// Stop recording for dictation mode: stop audio input and signal end-of-audio
    /// so the recognizer delivers a final transcription via the callback.
    /// Does NOT cancel the recognition task or set isRecording=false — the callback
    /// handles cleanup after receiving the isFinal result.
    private func stopRecordingForDictation() {
        guard isRecording else { return }
        log.info("Stopping dictation recording — waiting for final transcription")

        onRecordingStateChanged?(false)

        if audioEngine.isRunning {
            audioEngine.stop()
            audioEngine.inputNode.removeTap(onBus: 0)
        }

        // Signal end of audio — the recognizer will process remaining audio
        // and fire the callback with isFinal = true.
        recognitionRequest?.endAudio()
    }

    private func stopRecording() {
        guard isRecording else { return }

        isRecording = false
        onRecordingStateChanged?(false)
        currentDictationContext = nil
        // Overlay stays visible if we're transitioning to processing state (dictation sent
        // to daemon). Otherwise dismiss it — recording stopped without producing a result.
        if !awaitingDaemonResponse {
            overlayWindow.dismiss()
        }
        awaitingDaemonResponse = false  // reset for next recording
        log.info("Voice recording stopped")

        if audioEngine.isRunning {
            audioEngine.stop()
            audioEngine.inputNode.removeTap(onBus: 0)
        }
        recognitionTask?.cancel()
        recognitionTask = nil
        recognitionRequest?.endAudio()
        recognitionRequest = nil
    }
}
