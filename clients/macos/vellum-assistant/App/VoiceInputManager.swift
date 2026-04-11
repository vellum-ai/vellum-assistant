import Foundation
import AppKit
import Combine
import CoreGraphics
import Speech
import AVFoundation
import Accelerate
import os
import VellumAssistantShared

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "VoiceInput")


/// Determines how voice transcriptions are routed after speech recognition completes.
enum VoiceInputMode {
    case conversation  // existing behavior — transcription goes to chat
    case dictation     // transcription goes to daemon for cleanup, then inserted at cursor
}

/// Tracks the UI surface that initiated a voice recording session.
enum VoiceInputOrigin {
    case chatComposer
    case quickInput
    case hotkey
}

@MainActor
final class VoiceInputManager {
    var onTranscription: ((String) -> Void)?
    var onPartialTranscription: ((String) -> Void)?
    var onRecordingStateChanged: ((Bool) -> Void)?

    /// Controls how completed transcriptions are routed. Defaults to `.dictation` so
    /// voice input goes through the dictation cleanup path for cursor insertion.
    var currentMode: VoiceInputMode = .dictation

    /// Focused client used to process dictation requests in `.dictation` mode.
    private let dictationClient: any DictationClientProtocol

    /// Called when dictation processing returns a response (cleaned-up text + action plan).
    var onDictationResponse: ((DictationResponse) -> Void)?

    /// Called when the daemon classifies dictation as an action (e.g. "Slack Alex about the standup").
    /// The callback receives the original transcription text for routing to a full agent session.
    var onActionModeTriggered: ((String) -> Void)?

    /// Tracks which UI surface initiated the current recording session.
    var activeOrigin: VoiceInputOrigin = .hotkey

    /// Callback fired with smoothed amplitude values (~50ms intervals) during recording.
    var onAmplitudeChanged: ((Float) -> Void)?

    /// Direct amplitude publisher that bypasses ChatViewModel's 100ms coalescing.
    /// Views can subscribe via `onReceive` for real-time waveform updates.
    static let amplitudeSubject = CurrentValueSubject<Float, Never>(0)

    /// Mutable state for amplitude smoothing/throttling, captured by the audio tap closure
    /// so reads and writes happen entirely on the audio thread (no cross-thread races).
    private final class AmplitudeState {
        var previousSmoothed: Float = 0
        var lastEmissionTime: CFAbsoluteTime = 0
        func reset() { previousSmoothed = 0; lastEmissionTime = 0 }
    }
    private let amplitudeState = AmplitudeState()

    /// Context captured at activation time, describing the frontmost app state.
    var currentDictationContext: DictationContext?

    /// Floating overlay showing dictation state (recording/processing/done).
    private let overlayWindow = DictationOverlayWindow()

    /// Overlay for denied permission prompts (microphone/speech recognition).
    private let permissionOverlay = PermissionPromptOverlay()

    /// True after a dictation request has been sent and we're awaiting a response.
    /// Used by `stopRecording()` to decide whether the overlay should stay visible.
    private(set) var awaitingDaemonResponse = false

    /// Whether the microphone is currently recording for PTT/dictation.
    private(set) var isRecording = false

    /// Timestamp when the current recording session started. Used to detect
    /// micro-recordings that stop almost immediately (likely failures).
    private var recordingStartTime: CFAbsoluteTime = 0

    /// Guards against double-start/double-stop from rapid key events.
    private var isActivatorHeld = false

    /// Monotonically increasing counter identifying the current recording
    /// session. The async engine-start Task captures this value and checks
    /// it after `await` — if it no longer matches, the completion belongs
    /// to a stale session and is discarded.
    private var recordingGeneration: UInt64 = 0

    /// Whether `start()` has been called (monitors are active).
    /// Used to guard against duplicate registration from deferred startup.
    private(set) var hasStarted = false

    /// Guards access to `audioEngine.inputNode`. Accessing `inputNode` before
    /// microphone permission is granted triggers the system permission dialog,
    /// so teardown paths skip audio engine calls until a tap has been installed.
    private var hasInstalledTap = false

    /// When true, `tearDownAudioState()` skips the blocking `audioEngine.stop()`
    /// call. The OS reclaims all audio hardware resources on process exit, so
    /// explicit teardown is unnecessary during termination.
    private var isTerminating = false

    /// All active event monitors, consolidated for clean teardown.
    private var monitors: [Any] = []

    private var holdTask: Task<Void, Never>?
    private var otherKeyPressedDuringHold = false  // True if any other key pressed while holding
    private static let holdDelay: UInt64 = 300_000_000 // 300ms in nanoseconds
    private var lastAppSwitchTime: Date = .distantPast
    private var appSwitchObservers: [Any] = []

    /// The current PTT activator, read from the in-memory cache.
    var activator: PTTActivator {
        PTTActivator.cached
    }

    /// Injected adapter wrapping SFSpeechRecognizer static APIs and instance creation.
    private let speechRecognizerAdapter: any SpeechRecognizerAdapter

    private var speechRecognizer: SFSpeechRecognizer?
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private let engineController = AudioEngineController(label: "com.vellum.audioEngine.voiceInput")
    private var enginePrewarmed = false

    init(
        dictationClient: any DictationClientProtocol = DictationClient(),
        speechRecognizerAdapter: any SpeechRecognizerAdapter = AppleSpeechRecognizerAdapter()
    ) {
        self.dictationClient = dictationClient
        self.speechRecognizerAdapter = speechRecognizerAdapter
        self.speechRecognizer = speechRecognizerAdapter.makeRecognizer(locale: Locale(identifier: "en-US"))
    }

    func start() {
        hasStarted = true
        prewarmEngine()
        setupActivationMonitors()

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
            MainActor.assumeIsolated {
                guard let self else { return }
                self.lastAppSwitchTime = Date()
                self.holdTask?.cancel()
                self.holdTask = nil
                self.otherKeyPressedDuringHold = false
            }
        }
        let resignObserver = NotificationCenter.default.addObserver(
            forName: NSApplication.didResignActiveNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.lastAppSwitchTime = Date()
                self.holdTask?.cancel()
                self.holdTask = nil
                self.otherKeyPressedDuringHold = false
            }
        }
        // Cancel hold when the user switches Spaces (ctrl+arrow, ctrl+number, etc.).
        // didActivateApplicationNotification only fires when the frontmost app changes,
        // which doesn't happen when switching to an empty space or one with the same app.
        // activeSpaceDidChangeNotification fires on every Spaces switch.
        let spaceObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.activeSpaceDidChangeNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.lastAppSwitchTime = Date()
                self.holdTask?.cancel()
                self.holdTask = nil
                self.otherKeyPressedDuringHold = false
            }
        }
        appSwitchObservers = [workspaceObserver, resignObserver, spaceObserver]

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

    /// Marks the manager for termination, skipping blocking audio engine cleanup.
    func prepareForTermination() {
        isTerminating = true
    }

    func stop() {
        hasStarted = false
        for monitor in monitors {
            NSEvent.removeMonitor(monitor)
        }
        monitors = []
        for observer in appSwitchObservers {
            NSWorkspace.shared.notificationCenter.removeObserver(observer)
            NotificationCenter.default.removeObserver(observer)
        }
        appSwitchObservers = []
        isActivatorHeld = false
        stopRecording()
        overlayWindow.dismiss()
        permissionOverlay.dismiss()
    }

    /// Directly toggle recording on/off — used by UI mic buttons that bypass the Fn-key hold flow.
    /// The `origin` parameter tracks which UI surface initiated the recording.
    func toggleRecording(origin: VoiceInputOrigin = .hotkey) {
        if isRecording {
            stopRecording()
        } else {
            activeOrigin = origin
            log.debug("Dictation started (origin: \(String(describing: origin)))")
            beginRecording()
        }
    }

    /// Tear down audio engine state (tap, engine, recognition task/request).
    /// Safe to call regardless of `isRecording` — used as the shared cleanup path
    /// for all stop methods and as a recovery mechanism when state becomes inconsistent.
    /// Skips blocking `audioEngine.stop()` when `isTerminating` or no tap was installed.
    private func tearDownAudioState() {
        if hasInstalledTap && !isTerminating {
            engineController.tearDown()
        }
        hasInstalledTap = false
        recognitionTask?.cancel()
        recognitionTask = nil
        recognitionRequest?.endAudio()
        recognitionRequest = nil
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

        activeOrigin = .hotkey
        amplitudeState.reset()
        Self.amplitudeSubject.send(0)
        onAmplitudeChanged?(0)

        if hasInstalledTap {
            engineController.stopAndRemoveTap()
        }
        hasInstalledTap = false

        // Signal end of audio — the recognizer will process remaining audio
        // and fire the callback with isFinal = true.
        recognitionRequest?.endAudio()
    }

    /// Pre-initialize the audio engine so the first recording starts instantly.
    /// Skips pre-warming when microphone permission hasn't been granted yet —
    /// accessing the input node triggers the system permission dialog, which we want to
    /// avoid on dev rebuilds (where TCC resets to `.notDetermined` after re-signing).
    private func prewarmEngine() {
        guard !enginePrewarmed else { return }
        guard AVCaptureDevice.authorizationStatus(for: .audio) == .authorized else {
            log.info("Skipping audio engine pre-warm — microphone not yet authorized")
            return
        }
        engineController.prewarm()
        enginePrewarmed = true
    }

    /// Reset the audio engine to a clean state after an error.
    /// Clears any stale internal buffers or format caches that accumulate
    /// after failed start/stop cycles.
    private func resetAudioEngine() {
        engineController.reset()
        hasInstalledTap = false
    }

    // MARK: - Activation Monitor Setup

    private func setupActivationMonitors() {
        let current = activator
        switch current.kind {
        case .none:
            // PTT disabled — no monitors needed
            break

        case .modifierOnly:
            setupModifierOnlyMonitors()

        case .key, .modifierKey:
            setupKeyMonitors(activator: current)

        case .mouseButton:
            // Mouse button activators are not yet supported — fall back to
            // the default Fn key behavior and log a warning.
            log.warning("Mouse button activators are not yet supported, falling back to Fn")
            setupModifierOnlyMonitors()
        }
    }

    // MARK: - Modifier-Only Monitors (Fn, Ctrl, Fn+Shift)

    private func setupModifierOnlyMonitors() {
        let globalFlags = NSEvent.addGlobalMonitorForEvents(matching: .flagsChanged) { [weak self] event in
            Task { @MainActor in
                self?.handleFlagsChanged(event)
            }
        }
        let localFlags = NSEvent.addLocalMonitorForEvents(matching: .flagsChanged) { [weak self] event in
            Task { @MainActor in
                self?.handleFlagsChanged(event)
            }
            return event
        }

        // Monitor keyDown events to detect when user types while holding activation key
        // (e.g., Control+C, Control+Z) and cancel voice activation in those cases.
        let globalKeyDown = NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { [weak self] _ in
            Task { @MainActor in
                self?.handleOtherKeyDown()
            }
        }
        let localKeyDown = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            Task { @MainActor in
                self?.handleOtherKeyDown()
            }
            return event
        }

        if let m = globalFlags { monitors.append(m) }
        if let m = localFlags { monitors.append(m) }
        if let m = globalKeyDown { monitors.append(m) }
        if let m = localKeyDown { monitors.append(m) }
    }

    private func handleFlagsChanged(_ event: NSEvent) {
        guard let requiredFlags = activator.nsModifierFlags else { return }
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
            isActivatorHeld = true
            // Skip if an app switch happened recently — this Fn/Ctrl press is likely
            // from a system keyboard shortcut (Cmd+Tab, Ctrl+arrows) used to switch apps.
            guard Date().timeIntervalSince(lastAppSwitchTime) > 0.5 else { return }
            // Snapshot every key that is physically held right now (includes the
            // activation key itself). During the hold we only cancel if a NEW key
            // appears — one that wasn't already down at activation time. This avoids
            // any hardcoded list of modifier key codes or layout assumptions.
            var activationSnapshot = Set<CGKeyCode>()
            for code in CGKeyCode(0)...CGKeyCode(127) {
                if CGEventSource.keyState(.combinedSessionState, key: code) {
                    activationSnapshot.insert(code)
                }
            }
            holdTask = Task { [weak self, activationSnapshot] in
                // Poll every 25ms for 300ms total (12 polls).
                // CGEventSource.keyState reads hardware state directly, catching
                // keys consumed by system shortcuts before NSEvent monitors see them.
                let pollIntervalNs: UInt64 = 25_000_000
                let numPolls = Int(Self.holdDelay / pollIntervalNs)
                for _ in 0..<numPolls {
                    try? await Task.sleep(nanoseconds: pollIntervalNs)
                    guard !Task.isCancelled else { return }
                    guard let self = self else { return }
                    guard !self.otherKeyPressedDuringHold else { return }
                    guard Date().timeIntervalSince(self.lastAppSwitchTime) > 0.5 else { return }
                    // Cancel if any key not present at activation time is now held.
                    for code in CGKeyCode(0)...CGKeyCode(127) {
                        if !activationSnapshot.contains(code) &&
                            CGEventSource.keyState(.combinedSessionState, key: code) {
                            return
                        }
                    }
                }
                guard !Task.isCancelled else { return }
                guard let self = self else { return }
                guard self.shouldStartRecording(
                    activationKeyPressed: true,
                    otherKeyPressed: self.otherKeyPressedDuringHold,
                    timeSinceAppSwitch: Date().timeIntervalSince(self.lastAppSwitchTime),
                    isAlreadyRecording: self.isRecording
                ) else { return }
                self.captureContextAndBeginRecording()
            }
        } else if keyPressed && hasOtherModifiers {
            // Another modifier pressed - cancel voice activation
            holdTask?.cancel()
            holdTask = nil
        } else if !keyPressed {
            // Activation key released
            isActivatorHeld = false
            holdTask?.cancel()
            holdTask = nil
            if isRecording {
                stopRecordingByMode()
            }
        }
    }

    // MARK: - Key / ModifierKey Monitors (e.g. F5, Ctrl+F5)

    private func setupKeyMonitors(activator: PTTActivator) {
        guard let targetKeyCode = activator.keyCode else { return }
        let requiredModifiers = activator.nsModifierFlags

        // keyDown: start hold timer
        let globalKeyDown = NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { [weak self] event in
            Task { @MainActor in
                self?.handleActivatorKeyDown(event, targetKeyCode: targetKeyCode, requiredModifiers: requiredModifiers)
            }
        }
        let localKeyDown = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            Task { @MainActor in
                self?.handleActivatorKeyDown(event, targetKeyCode: targetKeyCode, requiredModifiers: requiredModifiers)
            }
            // Suppress the key from typing when it matches our activator
            if event.keyCode == targetKeyCode {
                if event.isARepeat { return nil }
                if let mods = requiredModifiers {
                    if event.modifierFlags.contains(mods) { return nil }
                } else {
                    return nil
                }
            }
            return event
        }

        // keyUp: stop recording
        let globalKeyUp = NSEvent.addGlobalMonitorForEvents(matching: .keyUp) { [weak self] event in
            Task { @MainActor in
                self?.handleActivatorKeyUp(event, targetKeyCode: targetKeyCode)
            }
        }
        let localKeyUp = NSEvent.addLocalMonitorForEvents(matching: .keyUp) { [weak self] event in
            Task { @MainActor in
                self?.handleActivatorKeyUp(event, targetKeyCode: targetKeyCode)
            }
            return event
        }

        if let m = globalKeyDown { monitors.append(m) }
        if let m = localKeyDown { monitors.append(m) }
        if let m = globalKeyUp { monitors.append(m) }
        if let m = localKeyUp { monitors.append(m) }
    }

    private func handleActivatorKeyDown(_ event: NSEvent, targetKeyCode: UInt16, requiredModifiers: NSEvent.ModifierFlags?) {
        guard event.keyCode == targetKeyCode else { return }
        guard !event.isARepeat else { return }
        guard !isActivatorHeld else { return }

        // Check modifier requirements
        if let mods = requiredModifiers {
            guard event.modifierFlags.contains(mods) else { return }
        }

        isActivatorHeld = true
        guard !isRecording else { return }

        holdTask?.cancel()
        otherKeyPressedDuringHold = false
        guard Date().timeIntervalSince(lastAppSwitchTime) > 0.5 else { return }

        // For key-based activators, snapshot keys and poll during hold period.
        // For key codes > 127, skip polling (uncommon keys outside CGEventSource range).
        var activationSnapshot = Set<CGKeyCode>()
        let maxPollCode: CGKeyCode = 127
        for code in CGKeyCode(0)...maxPollCode {
            if CGEventSource.keyState(.combinedSessionState, key: code) {
                activationSnapshot.insert(code)
            }
        }

        holdTask = Task { [weak self, activationSnapshot] in
            let pollIntervalNs: UInt64 = 25_000_000
            let numPolls = Int(Self.holdDelay / pollIntervalNs)
            for _ in 0..<numPolls {
                try? await Task.sleep(nanoseconds: pollIntervalNs)
                guard !Task.isCancelled else { return }
                guard let self = self else { return }
                guard !self.otherKeyPressedDuringHold else { return }
                guard Date().timeIntervalSince(self.lastAppSwitchTime) > 0.5 else { return }
                // Cancel if any key not present at activation time is now held.
                for code in CGKeyCode(0)...maxPollCode {
                    if !activationSnapshot.contains(code) &&
                        CGEventSource.keyState(.combinedSessionState, key: code) {
                        return
                    }
                }
            }
            guard !Task.isCancelled else { return }
            guard let self = self else { return }
            guard self.shouldStartRecording(
                activationKeyPressed: true,
                otherKeyPressed: self.otherKeyPressedDuringHold,
                timeSinceAppSwitch: Date().timeIntervalSince(self.lastAppSwitchTime),
                isAlreadyRecording: self.isRecording
            ) else { return }
            self.captureContextAndBeginRecording()
        }
    }

    private func handleActivatorKeyUp(_ event: NSEvent, targetKeyCode: UInt16) {
        guard event.keyCode == targetKeyCode else { return }
        guard isActivatorHeld else { return }

        isActivatorHeld = false
        holdTask?.cancel()
        holdTask = nil
        if isRecording {
            stopRecordingByMode()
        }
    }

    // MARK: - Shared Helpers

    private func handleOtherKeyDown() {
        // If user types any key while holding the activation modifier (e.g. Control+C),
        // set flag to prevent recording and cancel timer for immediate feedback
        otherKeyPressedDuringHold = true
        holdTask?.cancel()
        holdTask = nil
    }

    /// Start recording immediately for instant UI feedback, then capture
    /// frontmost app context off the main actor. The engine starts
    /// asynchronously on its audio queue while context capture runs on a
    /// detached Task — both happen concurrently without blocking the main
    /// actor, so key-up events are processed immediately.
    ///
    /// When Vellum itself is the frontmost app, skip context capture so the
    /// transcription falls through to the conversation path (auto-submit to chat)
    /// instead of going through DictationTextInserter which would double-insert.
    private func captureContextAndBeginRecording() {
        beginRecording()
        guard isRecording else { return }
        if currentMode == .dictation {
            let isVellumFrontmost = NSWorkspace.shared.frontmostApplication?.bundleIdentifier == Bundle.main.bundleIdentifier
            if !isVellumFrontmost {
                let generation = recordingGeneration
                Task.detached { [weak self] in
                    let context = DictationContextCapture.capture()
                    await MainActor.run { [weak self] in
                        guard let self else { return }
                        guard self.isRecording, self.recordingGeneration == generation else { return }
                        self.currentDictationContext = context
                    }
                }
            }
        }
    }

    /// Stop recording using the appropriate method for the current mode.
    private func stopRecordingByMode() {
        if currentMode == .dictation {
            stopRecordingForDictation()
        } else {
            stopRecording()
        }
    }

    // MARK: - Hold Detection Logic (extracted for testability)

    /// Pure decision function: should recording begin after the hold timer fires?
    /// Extracted from the hold detection closure so it can be unit-tested without NSEvent mocking.
    func shouldStartRecording(
        activationKeyPressed: Bool,
        otherKeyPressed: Bool,
        timeSinceAppSwitch: TimeInterval,
        isAlreadyRecording: Bool
    ) -> Bool {
        guard activationKeyPressed else { return false }
        guard !otherKeyPressed else { return false }
        guard timeSinceAppSwitch > 0.5 else { return false }
        guard !isAlreadyRecording else { return false }
        return true
    }

    // MARK: - Recording

    private func beginRecording() {
        log.info("beginRecording() called — origin=\(String(describing: self.activeOrigin)) mode=\(String(describing: self.currentMode)) isRecording=\(self.isRecording)")

        // Recreate speech recognizer if transiently unavailable (e.g. after
        // sleep/wake, heavy use, or audio route changes).
        if speechRecognizer?.isAvailable != true {
            log.warning("Speech recognizer unavailable (nil=\(self.speechRecognizer == nil)) — recreating")
            speechRecognizer = speechRecognizerAdapter.makeRecognizer(locale: Locale(identifier: "en-US"))
        }
        guard let speechRecognizer = speechRecognizer, speechRecognizer.isAvailable else {
            log.error("Speech recognizer not available after recreation attempt (nil=\(self.speechRecognizer == nil), available=\(self.speechRecognizer?.isAvailable ?? false))")
            currentDictationContext = nil
            return
        }

        // Don't start if a previous recognition task is still processing
        if recognitionTask != nil {
            log.warning("Previous recognition task still active (state=\(String(describing: self.recognitionTask?.state))), skipping")
            currentDictationContext = nil
            return
        }

        // Check microphone and speech permissions before recording.
        // Show an informative overlay for first-use or denied states instead of
        // silently opening System Settings.
        let micStatus = AVCaptureDevice.authorizationStatus(for: .audio)
        let speechStatus = speechRecognizerAdapter.authorizationStatus()
        log.info("Permissions — mic=\(String(describing: micStatus)) speech=\(String(describing: speechStatus))")

        if micStatus == .notDetermined || speechStatus == .notDetermined {
            // Show a primer explaining why we need mic access, then request.
            log.info("Showing permission primer (mic=\(String(describing: micStatus)) speech=\(String(describing: speechStatus)))")
            currentDictationContext = nil
            permissionOverlay.show(kind: .firstUse, onDismiss: {}, onContinue: { [weak self] in
                Task { @MainActor in
                    await self?.requestPermissionsAndRecord()
                }
            })
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
            log.warning("Permission denied — showing overlay (mic=\(String(describing: micStatus)) speech=\(String(describing: speechStatus)))")
            permissionOverlay.show(kind: .denied(deniedPermission), onDismiss: {}, onContinue: {})
            currentDictationContext = nil
            return
        }

        // Show recording state and play chime immediately for instant feedback.
        // The audio engine starts asynchronously below — the user hears/sees the
        // activation before the engine is ready, hiding hardware latency.
        recordingGeneration &+= 1
        let generation = recordingGeneration
        isRecording = true
        recordingStartTime = CFAbsoluteTimeGetCurrent()
        onRecordingStateChanged?(true)
        if currentMode == .dictation {
            if activeOrigin == .chatComposer {
                log.debug("Overlay suppressed for chatComposer origin")
            } else {
                overlayWindow.show(state: .recording)
            }
        }
        log.info("Voice recording started")
        VoiceFeedback.playActivationChime()

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        recognitionRequest = request

        let ampState = amplitudeState
        ampState.reset()

        let tapBlock: AVAudioNodeTapBlock = { [weak self] buffer, _ in
            request.append(buffer)

            guard let channelData = buffer.floatChannelData else { return }
            let frameLength = Int(buffer.frameLength)
            guard frameLength > 0 else { return }

            let channelDataArray = Array(UnsafeBufferPointer(start: channelData[0], count: frameLength))
            let rawRMS = vDSP.rootMeanSquare(channelDataArray)

            let smoothed = 0.5 * rawRMS + 0.5 * ampState.previousSmoothed
            ampState.previousSmoothed = smoothed

            // Scale amplitude to 0-1 range for waveform visualization.
            // Speech RMS is typically 0.01-0.1; multiply to fill the visual range.
            let scaled = min(smoothed * 14.0, 1.0)

            let now = CFAbsoluteTimeGetCurrent()
            guard now - ampState.lastEmissionTime >= 0.033 else { return }
            ampState.lastEmissionTime = now

            VoiceInputManager.amplitudeSubject.send(scaled)
            DispatchQueue.main.async { [weak self] in
                self?.onAmplitudeChanged?(scaled)
            }
        }

        // Start the audio engine asynchronously to avoid blocking the main
        // thread during Bluetooth negotiation or hardware initialization.
        // The recognition task is started in the completion after the engine
        // is running. This eliminates the 2+ second main-thread stall that
        // occurs with queue.sync when coreaudiod is contended.
        Task { [weak self] in
            guard let self else { return }
            let success = await self.engineController.installTapAndStartAsync(
                bufferSize: 1024,
                block: tapBlock
            )
            // Verify this completion belongs to the current recording session.
            // A quick release/retry can cause session A's completion to arrive
            // while session B is active — using the stale request would
            // desynchronize recognitionTask/recognitionRequest ownership.
            guard self.isRecording, self.recordingGeneration == generation else {
                // Only tear down if no session is currently active. When a newer
                // session is running (isRecording true, generation mismatch),
                // it owns the engine — tearing down here would remove its tap.
                if success, !self.isRecording {
                    self.engineController.stopAndRemoveTap()
                    log.info("Engine started for stale generation \(generation) — tore down (no active session)")
                } else if success {
                    log.info("Stale generation \(generation) completed — skipping teardown, session \(self.recordingGeneration) owns engine")
                }
                return
            }
            guard success else {
                let elapsed = CFAbsoluteTimeGetCurrent() - self.recordingStartTime
                log.error("Audio engine failed to start after \(String(format: "%.1f", elapsed))s — invalid format or engine error. Resetting engine for next attempt.")
                self.isRecording = false
                self.onRecordingStateChanged?(false)
                self.currentDictationContext = nil
                self.recognitionRequest = nil
                self.overlayWindow.dismiss()
                self.resetAudioEngine()
                return
            }
            self.hasInstalledTap = true

            self.recognitionTask = speechRecognizer.recognitionTask(with: request) { [weak self] result, error in
                Task { @MainActor in
                    guard let self = self else { return }
                    // Ignore late callbacks delivered after recording was stopped
                    // (e.g. endAudio() triggering a delayed isFinal via Task dispatch).
                    guard self.isRecording else { return }

                    if let result = result {
                        let text = result.bestTranscription.formattedString
                        if result.isFinal {
                            let elapsed = CFAbsoluteTimeGetCurrent() - self.recordingStartTime
                            log.info("Final transcription after \(String(format: "%.1f", elapsed))s: \"\(text, privacy: .public)\"")
                            if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                                self.handleFinalTranscription(text)
                            } else {
                                log.warning("Empty final transcription after \(String(format: "%.1f", elapsed))s — stopping recording")
                                VoiceFeedback.playDeactivationChime()
                            }
                            self.recognitionTask = nil
                            self.stopRecording()
                        } else {
                            self.onPartialTranscription?(text)
                            if self.currentMode == .dictation {
                                self.overlayWindow.updatePartialTranscription(text)
                            }
                        }
                    }

                    if let error = error {
                        let elapsed = CFAbsoluteTimeGetCurrent() - self.recordingStartTime
                        log.error("Recognition error after \(String(format: "%.1f", elapsed))s: \(error.localizedDescription) (domain=\((error as NSError).domain) code=\((error as NSError).code))")
                        self.recognitionTask = nil
                        VoiceFeedback.playDeactivationChime()
                        self.stopRecording()
                    }
                }
            }
        }
    }

    // MARK: - Permission Prompt



    /// Request both microphone and speech recognition permissions sequentially,
    /// then start recording if both are granted.
    private func requestPermissionsAndRecord() async {
        let micGranted = await AVCaptureDevice.requestAccess(for: .audio)
        guard micGranted else {
            log.warning("Microphone access denied by user")
            permissionOverlay.show(kind: .denied(.microphone), onDismiss: {}, onContinue: {})
            return
        }

        let speechGranted = await withCheckedContinuation { continuation in
            speechRecognizerAdapter.requestAuthorization { status in
                continuation.resume(returning: status == .authorized)
            }
        }
        guard speechGranted else {
            log.warning("Speech recognition access denied by user")
            permissionOverlay.show(kind: .denied(.speechRecognition), onDismiss: {}, onContinue: {})
            return
        }

        log.info("Permissions granted — starting recording")
        prewarmEngine()
        self.beginRecording()
        guard self.isRecording else { return }
        if self.currentMode == .dictation {
            let generation = self.recordingGeneration
            Task.detached { [weak self] in
                let context = DictationContextCapture.capture()
                await MainActor.run { [weak self] in
                    guard let self else { return }
                    guard self.isRecording, self.recordingGeneration == generation else { return }
                    self.currentDictationContext = context
                }
            }
        }
    }


    /// Routes a final transcription based on the current mode.
    func handleFinalTranscription(_ text: String) {
        switch currentMode {
        case .conversation:
            VoiceFeedback.playDeactivationChime()
            onTranscription?(text)
        case .dictation:
            guard let context = currentDictationContext else {
                // No context captured (e.g. continuous recording path) — fall back to conversation
                VoiceFeedback.playDeactivationChime()
                onTranscription?(text)
                return
            }
            let request = DictationRequest(
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
            awaitingDaemonResponse = true
            log.info("Sending dictation request via DictationClient for app=\(context.appName, privacy: .public)")

            let dictationClient = self.dictationClient
            Task { [weak self] in
                let response = await dictationClient.process(request)
                await MainActor.run {
                    guard let self else { return }
                    self.onDictationResponse?(response)
                }
            }
        }
    }

    /// Handle the dictation response — insert cleaned text or route action mode to a task.
    func handleDictationResponse(text: String, mode: String) {
        awaitingDaemonResponse = false
        if mode == "dictation" || mode == "command" {
            DictationTextInserter.insertText(text)
            overlayWindow.showDoneAndDismiss()
            VoiceFeedback.playDeactivationChime()
        } else if mode == "action" {
            overlayWindow.dismiss()
            VoiceFeedback.playDeactivationChime()
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

        if hasInstalledTap {
            engineController.stopAndRemoveTap()
        }
        hasInstalledTap = false

        // If the recognition task hasn't been started yet (async engine start
        // still in progress), there's no callback to deliver isFinal.
        // Clean up directly instead of waiting for a callback that won't come.
        guard recognitionTask != nil else {
            log.info("Recognition task not yet started — cleaning up directly")
            recognitionRequest = nil
            isRecording = false
            currentDictationContext = nil
            activeOrigin = .hotkey
            amplitudeState.reset()
            Self.amplitudeSubject.send(0)
            onAmplitudeChanged?(0)
            overlayWindow.dismiss()
            VoiceFeedback.playDeactivationChime()
            return
        }

        // Signal end of audio — the recognizer will process remaining audio
        // and fire the callback with isFinal = true.
        recognitionRequest?.endAudio()
    }

    private func stopRecording() {
        guard isRecording else {
            log.info("stopRecording() called but isRecording=false — tearing down audio state only")
            // Even when isRecording is false, audio state may be inconsistent
            // (e.g. a prior error set isRecording=false without fully cleaning up).
            // Tear down unconditionally so the cancel button always works.
            tearDownAudioState()
            return
        }

        let elapsed = CFAbsoluteTimeGetCurrent() - recordingStartTime
        if elapsed < 1.0 {
            log.warning("Micro-recording detected: recording stopped after only \(String(format: "%.2f", elapsed))s — likely a failure, not user action")
        }

        isRecording = false
        onRecordingStateChanged?(false)
        currentDictationContext = nil
        activeOrigin = .hotkey
        amplitudeState.reset()
        Self.amplitudeSubject.send(0)
        onAmplitudeChanged?(0)
        // Overlay stays visible if we're transitioning to processing state (dictation sent
        // to daemon). Otherwise dismiss it — recording stopped without producing a result.
        if !awaitingDaemonResponse {
            overlayWindow.dismiss()
        }
        awaitingDaemonResponse = false  // reset for next recording
        log.info("Voice recording stopped after \(String(format: "%.1f", elapsed))s")

        tearDownAudioState()
    }
}
