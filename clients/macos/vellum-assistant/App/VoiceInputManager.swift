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

    /// STT service client for service-first transcription resolution.
    /// When configured, final transcriptions are resolved via the STT service
    /// before falling back to the Apple recognizer's native text.
    private let sttClient: any STTClientProtocol

    /// Factory that creates a new `STTStreamingClientProtocol` instance for each
    /// streaming session. Injected at init for testability — tests supply a mock
    /// factory that returns controllable streaming clients.
    private let streamingClientFactory: () -> any STTStreamingClientProtocol

    /// Active streaming STT client for the current conversation recording session.
    /// Non-nil only while a streaming session is in progress.
    private var streamingClient: (any STTStreamingClientProtocol)?

    /// Whether the streaming client has received a `ready` event and is accepting audio.
    /// Internal access for testability via `@testable import`.
    var streamingSessionActive = false

    /// Accumulates final transcript segments from the streaming session.
    /// Multiple `.final` events may arrive during a single recording; they are
    /// concatenated to form the complete transcript.
    /// Internal access for testability via `@testable import`.
    var streamingFinalText = ""

    /// Whether the streaming session has delivered at least one `.final` event.
    /// Used to decide whether to use the streaming transcript or fall back to
    /// batch STT resolution when recording stops.
    /// Internal access for testability via `@testable import`.
    var streamingReceivedFinal = false

    /// Set to `true` when the streaming session encounters a failure (connection
    /// error, provider error, abnormal closure). When set, `stopRecording()` falls
    /// back to the batch STT resolution path instead of using streaming finals.
    /// Internal access for testability via `@testable import`.
    var streamingFailed = false

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

    /// Accumulates raw PCM audio buffers during a recording session for STT
    /// service transcription. Thread-safe: writes happen on the audio tap's
    /// dispatch queue; reads happen on the main actor after recording stops.
    private final class AudioBufferAccumulator: @unchecked Sendable {
        private var buffers: [AVAudioPCMBuffer] = []
        private let lock = NSLock()

        func append(_ buffer: AVAudioPCMBuffer) {
            lock.lock()
            buffers.append(buffer)
            lock.unlock()
        }

        func drain() -> [AVAudioPCMBuffer] {
            lock.lock()
            let result = buffers
            buffers.removeAll()
            lock.unlock()
            return result
        }

        func reset() {
            lock.lock()
            buffers.removeAll()
            lock.unlock()
        }
    }

    /// Collects PCM audio during the current recording session.
    private let audioAccumulator = AudioBufferAccumulator()

    /// The audio format captured from the input node at recording start.
    /// Needed to encode the accumulated buffers into WAV when the session ends.
    private var capturedAudioFormat: AVAudioFormat?

    /// Injected adapter wrapping SFSpeechRecognizer static APIs and instance creation.
    private let speechRecognizerAdapter: any SpeechRecognizerAdapter

    private var speechRecognizer: SFSpeechRecognizer?
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private let engineController = AudioEngineController(label: "com.vellum.audioEngine.voiceInput")
    private var enginePrewarmed = false

    init(
        dictationClient: any DictationClientProtocol = DictationClient(),
        speechRecognizerAdapter: any SpeechRecognizerAdapter = AppleSpeechRecognizerAdapter(),
        sttClient: any STTClientProtocol = STTClient(),
        streamingClientFactory: @escaping () -> any STTStreamingClientProtocol = { STTStreamingClient() }
    ) {
        self.dictationClient = dictationClient
        self.speechRecognizerAdapter = speechRecognizerAdapter
        self.sttClient = sttClient
        self.streamingClientFactory = streamingClientFactory
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
            stopRecordingByMode()
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
        tearDownStreamingSession()
    }

    /// Clean up the streaming STT session. Safe to call even when no streaming
    /// session is active. Signals graceful stop before forcible close.
    ///
    /// The `stop()` and `close()` calls are fire-and-forget — the streaming
    /// session state is reset synchronously below regardless of whether the
    /// server has acknowledged the stop. Any in-flight finals from the server
    /// are discarded. This is safe because callers of `tearDownStreamingSession`
    /// have already committed to a resolution path (e.g. batch STT or the
    /// streaming finals that were received before teardown).
    private func tearDownStreamingSession() {
        if let client = streamingClient {
            Task {
                await client.stop()
                await client.close()
            }
        }
        streamingClient = nil
        streamingSessionActive = false
        streamingFinalText = ""
        streamingReceivedFinal = false
        streamingFailed = false
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

        let sttConfigured = STTProviderRegistry.isServiceConfigured

        // Check recognizer availability through the adapter so tests can
        // control the result without depending on a real SFSpeechRecognizer.
        // When unavailable, attempt recreation before giving up.
        //
        // The adapter's `isRecognizerAvailable` handles the case where no
        // recognizer has been created yet. Additionally, after sleep/wake the
        // cached `speechRecognizer` instance may become transiently unavailable
        // while a freshly-created recognizer reports "available". Check the
        // cached instance's `.isAvailable` to detect stale recognizers and
        // recreate them before the recognition task fails.
        if speechRecognizer == nil || !speechRecognizerAdapter.isRecognizerAvailable || speechRecognizer?.isAvailable == false {
            log.warning("Speech recognizer unavailable (nil=\(self.speechRecognizer == nil), adapterAvailable=\(self.speechRecognizerAdapter.isRecognizerAvailable), cachedAvailable=\(String(describing: self.speechRecognizer?.isAvailable))) — recreating")
            speechRecognizer = speechRecognizerAdapter.makeRecognizer(locale: Locale(identifier: "en-US"))
        }

        // When STT is configured, the native recognizer is optional — if it's
        // available we get partials, but recording proceeds without it. When STT
        // is NOT configured, the native recognizer is required.
        if !sttConfigured {
            guard speechRecognizerAdapter.isRecognizerAvailable else {
                log.error("Speech recognizer not available after recreation attempt")
                currentDictationContext = nil
                return
            }
        }

        // Determine whether we can use the native recognizer for partials.
        let speechStatus = speechRecognizerAdapter.authorizationStatus()
        let useNativeRecognizer: Bool = speechRecognizerAdapter.isRecognizerAvailable
            && speechRecognizer != nil
            && speechStatus == .authorized

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
        log.info("Permissions — mic=\(String(describing: micStatus)) speech=\(String(describing: speechStatus)) sttConfigured=\(sttConfigured)")

        // Determine which permissions still need first-use prompts.
        let micNotDetermined = micStatus == .notDetermined
        let speechNotDetermined = speechStatus == .notDetermined

        // Show the first-use primer when:
        // - mic is not yet determined (always need mic), OR
        // - speech is not yet determined AND STT is NOT configured (speech required).
        // When STT is configured, speech notDetermined is fine — skip the primer
        // and proceed directly to recording with STT-only mode.
        if micNotDetermined || (!sttConfigured && speechNotDetermined) {
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
        // Microphone is always required. Speech recognition is only required
        // when no STT service is configured.
        if micDenied || (!sttConfigured && speechDenied) {
            let deniedPermission: PermissionPromptOverlay.DeniedPermission
            if micDenied && speechDenied && !sttConfigured {
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
        log.info("Voice recording started (useNativeRecognizer=\(useNativeRecognizer))")
        VoiceFeedback.playActivationChime()

        // Only create the recognition request when we have a working native recognizer.
        let request: SFSpeechAudioBufferRecognitionRequest?
        if useNativeRecognizer {
            let req = SFSpeechAudioBufferRecognitionRequest()
            req.shouldReportPartialResults = true
            recognitionRequest = req
            request = req
        } else {
            request = nil
        }

        let ampState = amplitudeState
        ampState.reset()
        audioAccumulator.reset()
        capturedAudioFormat = nil

        // Determine whether to start a streaming STT session for this recording.
        // Streaming is used in conversation mode when the configured provider supports it.
        let useConversationStreaming = currentMode == .conversation && STTProviderRegistry.isStreamingAvailable

        let accumulator = audioAccumulator
        let tapBlock: AVAudioNodeTapBlock = { [weak self] buffer, _ in
            // Capture the audio format from the first buffer for WAV encoding.
            if self?.capturedAudioFormat == nil {
                DispatchQueue.main.async { [weak self] in
                    if self?.capturedAudioFormat == nil {
                        self?.capturedAudioFormat = buffer.format
                    }
                }
            }
            // Feed the native recognizer only when a recognition request exists.
            request?.append(buffer)
            // Capture a copy of the PCM buffer for STT service transcription.
            // AVAudioPCMBuffer is reused by the audio engine across callbacks,
            // so we must copy the data before the engine overwrites it.
            if let copy = AVAudioPCMBuffer(pcmFormat: buffer.format, frameCapacity: buffer.frameLength) {
                copy.frameLength = buffer.frameLength
                if let src = buffer.floatChannelData, let dst = copy.floatChannelData {
                    for ch in 0..<Int(buffer.format.channelCount) {
                        dst[ch].update(from: src[ch], count: Int(buffer.frameLength))
                    }
                }
                accumulator.append(copy)
            }

            // Forward audio to the streaming STT client when a streaming session
            // is active. Converts float PCM → 16-bit signed integer PCM (the
            // format expected by the gateway's STT streaming endpoint).
            // Always send mono (channel 0 only) regardless of the input device's
            // channel count — the Deepgram adapter sends `channels=1`, so
            // multi-channel interleaved PCM would be misinterpreted.
            if useConversationStreaming,
               let channelData = buffer.floatChannelData {
                let frameCount = Int(buffer.frameLength)
                let channelCount = Int(buffer.format.channelCount)
                if frameCount > 0, channelCount > 0 {
                    var pcmData = Data(capacity: frameCount * 2)
                    for frame in 0..<frameCount {
                        let sample = channelData[0][frame]
                        let clamped = max(-1.0, min(1.0, sample))
                        let int16 = Int16(clamped * Float(Int16.max))
                        withUnsafeBytes(of: int16.littleEndian) { pcmData.append(contentsOf: $0) }
                    }
                    let capturedGeneration = generation
                    DispatchQueue.main.async { [weak self] in
                        guard let self, self.isRecording, self.recordingGeneration == capturedGeneration,
                              self.streamingSessionActive else { return }
                        Task { await self.streamingClient?.sendAudio(pcmData) }
                    }
                }
            }

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

            // Start the streaming STT session if conversation streaming is enabled.
            // This runs concurrently with the native recognizer (if available) —
            // streaming provides live partials and finals while the native recognizer
            // serves as a fallback source.
            if useConversationStreaming {
                self.startStreamingSession(generation: generation)
            }

            // When native recognizer is not available/authorized, recording
            // still proceeds — STT service handles transcription on stop.
            guard useNativeRecognizer, let recognizer = self.speechRecognizer, let req = request else {
                log.info("Recording without native recognizer — STT service will handle transcription on stop")
                return
            }

            self.recognitionTask = recognizer.recognitionTask(with: req) { [weak self] result, error in
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
                            // When a streaming STT session is active and healthy,
                            // streaming partials take priority over native recognizer
                            // partials to avoid competing UI updates. Native partials
                            // still serve as fallback when streaming has failed.
                            let streamingOwnsPartials = self.streamingSessionActive && !self.streamingFailed
                            if !streamingOwnsPartials {
                                self.onPartialTranscription?(text)
                            }
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

    // MARK: - Streaming STT Session

    /// Start an STT streaming session for conversation mode.
    ///
    /// Creates a new `STTStreamingClient` via the injected factory, connects to
    /// the gateway WebSocket, and wires up event/failure callbacks. The streaming
    /// session provides live partial transcript updates that are forwarded through
    /// `onPartialTranscription`, and final transcript segments that are accumulated
    /// for use when recording stops.
    ///
    /// The `generation` parameter is captured at recording start and checked in
    /// all callbacks to suppress stale-session deliveries.
    private func startStreamingSession(generation: UInt64) {
        guard let providerId = UserDefaults.standard.string(forKey: "sttProvider"),
              !providerId.isEmpty else {
            log.warning("Streaming session requested but no STT provider configured")
            streamingFailed = true
            return
        }

        let client = streamingClientFactory()
        self.streamingClient = client

        // Determine audio format parameters. `capturedAudioFormat` is set from
        // the first audio buffer; if not yet available, the server will use its
        // default sample rate.
        let sampleRate: Int? = capturedAudioFormat.map { Int($0.sampleRate) }

        Task { [weak self] in
            await client.start(
                provider: providerId,
                mimeType: "audio/pcm",
                sampleRate: sampleRate,
                onEvent: { [weak self] event in
                    guard let self else { return }
                    // Suppress events from stale sessions.
                    guard self.isRecording, self.recordingGeneration == generation else {
                        log.debug("Streaming event from stale generation \(generation) — ignoring")
                        return
                    }
                    self.handleStreamingEvent(event)
                },
                onFailure: { [weak self] failure in
                    guard let self else { return }
                    guard self.isRecording, self.recordingGeneration == generation else {
                        log.debug("Streaming failure from stale generation \(generation) — ignoring")
                        return
                    }
                    self.handleStreamingFailure(failure)
                }
            )
        }
    }

    /// Handle an incoming event from the streaming STT session.
    private func handleStreamingEvent(_ event: STTStreamEvent) {
        switch event {
        case .ready(let provider):
            log.info("Streaming STT ready: provider=\(provider)")
            streamingSessionActive = true

        case .partial(let text, _):
            // Forward streaming partials to the UI. In conversation mode,
            // these update the chat composer / quick input in real time.
            onPartialTranscription?(text)

        case .final(let text, _):
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty {
                if streamingFinalText.isEmpty {
                    streamingFinalText = text
                } else {
                    streamingFinalText += " " + text
                }
                streamingReceivedFinal = true
                log.info("Streaming final segment: \"\(text, privacy: .public)\"")
            }

        case .error(let category, let message, _):
            log.warning("Streaming STT error: category=\(category), message=\(message)")
            // Provider errors during an active session mark the stream as
            // failed so we fall back to batch on stop.
            streamingFailed = true

        case .closed:
            log.info("Streaming STT session closed")
            streamingSessionActive = false
        }
    }

    /// Handle a streaming session failure (connection error, timeout, etc.).
    private func handleStreamingFailure(_ failure: STTStreamFailure) {
        log.warning("Streaming STT failure: \(String(describing: failure)) — will fall back to batch STT")
        streamingFailed = true
        streamingSessionActive = false
    }

    // MARK: - Permission Prompt

    /// Request microphone (and optionally speech recognition) permissions,
    /// then start recording if granted.
    ///
    /// When an STT service is configured, only microphone permission is
    /// required. Speech recognition permission is skipped because the STT
    /// service handles transcription.
    private func requestPermissionsAndRecord() async {
        let micGranted = await AVCaptureDevice.requestAccess(for: .audio)
        guard micGranted else {
            log.warning("Microphone access denied by user")
            permissionOverlay.show(kind: .denied(.microphone), onDismiss: {}, onContinue: {})
            return
        }

        // When STT is configured, skip speech recognition permission request —
        // the STT service provides transcription. The native recognizer is a
        // nice-to-have for partials but not required.
        if !STTProviderRegistry.isServiceConfigured {
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
    ///
    /// In conversation mode, prefers the streaming STT final text when available
    /// and the stream has not failed. Falls back to the provided `text` (from the
    /// native recognizer or batch STT) otherwise.
    ///
    /// For dictation mode, resolves the final text with service-first precedence:
    /// 1. If the STT service returns a non-empty transcription, use that.
    /// 2. If the STT service is unconfigured, fails, or returns empty text,
    ///    fall back to the Apple recognizer's native text.
    func handleFinalTranscription(_ text: String) {
        switch currentMode {
        case .conversation:
            // Prefer streaming final text when the stream succeeded and delivered
            // at least one final segment. Fall back to the native/batch text
            // when streaming was not used, failed, or produced no finals.
            let resolvedText: String
            if streamingReceivedFinal && !streamingFailed {
                let trimmed = streamingFinalText.trimmingCharacters(in: .whitespacesAndNewlines)
                if !trimmed.isEmpty {
                    log.info("Using streaming STT final for conversation: \"\(self.streamingFinalText, privacy: .public)\"")
                    resolvedText = streamingFinalText
                } else {
                    resolvedText = text
                }
            } else {
                resolvedText = text
            }
            VoiceFeedback.playDeactivationChime()
            onTranscription?(resolvedText)
        case .dictation:
            guard let context = currentDictationContext else {
                // No context captured (e.g. continuous recording path or quick key release
                // before context capture completes). If we have accumulated audio, resolve
                // via the STT service so the user's speech isn't silently lost.
                let accumulatedBuffers = audioAccumulator.drain()
                let audioFormat = capturedAudioFormat
                if !accumulatedBuffers.isEmpty, audioFormat != nil {
                    let sttClient = self.sttClient
                    Task { [weak self] in
                        let resolvedText = await Self.resolveTranscription(
                            nativeText: text,
                            accumulatedBuffers: accumulatedBuffers,
                            audioFormat: audioFormat,
                            sttClient: sttClient
                        )
                        guard let self else { return }
                        if !resolvedText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                            VoiceFeedback.playDeactivationChime()
                            self.onTranscription?(resolvedText)
                        } else {
                            VoiceFeedback.playDeactivationChime()
                            self.showSpeechRecognitionFallbackPrompt()
                        }
                    }
                } else {
                    VoiceFeedback.playDeactivationChime()
                    if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        onTranscription?(text)
                    }
                }
                return
            }

            // Drain accumulated audio before any async work — buffers are only
            // valid for the current recording session.
            let accumulatedBuffers = audioAccumulator.drain()
            let audioFormat = capturedAudioFormat

            if let selected = context.selectedText, !selected.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                overlayWindow.show(state: .transforming(text))
            } else {
                overlayWindow.show(state: .processing)
            }
            awaitingDaemonResponse = true

            let sttClient = self.sttClient
            let dictationClient = self.dictationClient
            Task { [weak self] in
                // Resolve final text via STT service first, falling back to native.
                let resolvedText = await Self.resolveTranscription(
                    nativeText: text,
                    accumulatedBuffers: accumulatedBuffers,
                    audioFormat: audioFormat,
                    sttClient: sttClient
                )
                log.info("Resolved transcription for dictation (serviceFirst=\(resolvedText != text)): \"\(resolvedText, privacy: .public)\"")

                // When both STT service and native recognizer produced nothing,
                // show an error overlay instead of sending empty text to the daemon.
                if resolvedText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    log.warning("STT-only dictation produced no transcription — prompting for speech recognition")
                    await MainActor.run { [weak self] in
                        guard let self else { return }
                        self.awaitingDaemonResponse = false
                        self.overlayWindow.dismiss()
                        VoiceFeedback.playDeactivationChime()
                        self.showSpeechRecognitionFallbackPrompt()
                    }
                    return
                }

                let request = DictationRequest(
                    transcription: resolvedText,
                    context: .create(
                        bundleIdentifier: context.bundleIdentifier,
                        appName: context.appName,
                        windowTitle: context.windowTitle,
                        selectedText: context.selectedText,
                        cursorInTextField: context.cursorInTextField
                    )
                )
                log.info("Sending dictation request via DictationClient for app=\(context.appName, privacy: .public)")
                let response = await dictationClient.process(request)
                await MainActor.run {
                    guard let self else { return }
                    self.onDictationResponse?(response)
                }
            }
        }
    }

    // MARK: - STT Service-First Resolution

    /// Resolves the final transcription using service-first precedence.
    ///
    /// Encodes accumulated PCM audio buffers into WAV format and sends them
    /// to the STT service. If the service returns a non-empty transcription,
    /// that text is used. Otherwise, the Apple recognizer's native text is
    /// returned as a fallback.
    ///
    /// Static so it can be called from a detached context without capturing `self`.
    static func resolveTranscription(
        nativeText: String,
        accumulatedBuffers: [AVAudioPCMBuffer],
        audioFormat: AVAudioFormat?,
        sttClient: any STTClientProtocol
    ) async -> String {
        guard let format = audioFormat, !accumulatedBuffers.isEmpty else {
            log.info("STT service skipped — no audio data captured, using native text")
            return nativeText
        }

        // Encode accumulated PCM buffers into WAV.
        let wavData = Self.encodeBuffersToWav(accumulatedBuffers, format: format)
        guard !wavData.isEmpty else {
            log.warning("STT service skipped — WAV encoding produced empty data, using native text")
            return nativeText
        }

        let result = await sttClient.transcribe(audioData: wavData)
        switch result {
        case .success(let serviceText):
            let trimmed = serviceText.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty {
                return serviceText
            }
            log.info("STT service returned empty text — falling back to native")
            return nativeText
        case .notConfigured:
            log.info("STT service not configured — using native text")
            return nativeText
        case .serviceUnavailable:
            log.warning("STT service unavailable — using native text")
            return nativeText
        case .error(let statusCode, let message):
            log.warning("STT service error (status=\(String(describing: statusCode))): \(message) — using native text")
            return nativeText
        }
    }

    /// Encodes an array of `AVAudioPCMBuffer` into a single WAV `Data` payload
    /// using ``AudioWavEncoder``.
    ///
    /// Converts float PCM samples to 16-bit signed integers (the standard WAV
    /// PCM format expected by most STT providers). Handles multi-channel audio
    /// by interleaving samples.
    static func encodeBuffersToWav(_ buffers: [AVAudioPCMBuffer], format: AVAudioFormat) -> Data {
        var pcmData = Data()
        for buffer in buffers {
            guard let channelData = buffer.floatChannelData else { continue }
            let frameCount = Int(buffer.frameLength)
            let channelCount = Int(format.channelCount)
            guard frameCount > 0, channelCount > 0 else { continue }

            // Interleave channels and convert Float32 → Int16.
            for frame in 0..<frameCount {
                for ch in 0..<channelCount {
                    let sample = channelData[ch][frame]
                    let clamped = max(-1.0, min(1.0, sample))
                    let int16 = Int16(clamped * Float(Int16.max))
                    withUnsafeBytes(of: int16.littleEndian) { pcmData.append(contentsOf: $0) }
                }
            }
        }

        let wavFormat = AudioWavEncoder.Format(
            sampleRate: Int(format.sampleRate),
            channels: Int(format.channelCount),
            bitsPerSample: 16
        )
        return AudioWavEncoder.encode(pcmData: pcmData, format: wavFormat)
    }

    /// Show appropriate feedback after an STT transcription failure with no native fallback.
    ///
    /// - `.authorized`: Speech recognition is already granted — the failure is a transient
    ///   STT service error (missing API key, network issue, silence). Show a generic error.
    /// - `.notDetermined`: Show a speech-recognition-specific primer, then request
    ///   authorization. If granted, the next recording will have native fallback.
    /// - `.denied` / `.restricted`: Direct the user to System Settings.
    private func showSpeechRecognitionFallbackPrompt() {
        let speechStatus = speechRecognizerAdapter.authorizationStatus()
        switch speechStatus {
        case .authorized:
            // Speech recognition is already authorized — the failure is not a permission
            // issue. Show a generic transcription error in the dictation overlay.
            overlayWindow.show(state: .error("Transcription failed. Please try again."))
        case .notDetermined:
            // Show a speech-recognition-specific fallback prompt, then request authorization.
            // If granted, the next recording will have native partials + fallback.
            permissionOverlay.show(kind: .speechFallback, onDismiss: {}, onContinue: { [weak self] in
                self?.speechRecognizerAdapter.requestAuthorization { _ in }
            })
        case .denied, .restricted:
            // Speech recognition was previously denied — direct to System Settings.
            permissionOverlay.show(kind: .denied(.speechRecognition), onDismiss: {}, onContinue: {})
        @unknown default:
            overlayWindow.show(state: .error("Transcription failed. Please try again."))
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
    ///
    /// When recording without a native recognizer (STT-only mode), there is no
    /// `isFinal` callback to wait for. Instead, the accumulated audio is drained,
    /// encoded to WAV, and sent directly to the STT service.
    private func stopRecordingForDictation() {
        guard isRecording else { return }
        log.info("Stopping dictation recording — waiting for final transcription")

        onRecordingStateChanged?(false)

        if hasInstalledTap {
            engineController.stopAndRemoveTap()
        }
        hasInstalledTap = false

        // When there's no recognition task, either:
        // (a) the async engine start is still in progress, or
        // (b) we're recording in STT-only mode (no native recognizer).
        // In both cases, no isFinal callback will come — handle directly.
        guard recognitionTask != nil else {
            // Check if we have accumulated audio and an STT service to handle it.
            // Don't drain yet — handleFinalTranscription drains the accumulator
            // itself so the audio buffers flow through to resolveTranscription.
            let hasAudio = capturedAudioFormat != nil
            let sttConfigured = STTProviderRegistry.isServiceConfigured

            if hasAudio && sttConfigured {
                log.info("STT-only mode — routing through handleFinalTranscription for STT service resolution")
                // Route through handleFinalTranscription with empty native text.
                // resolveTranscription (called inside) will drain the accumulator,
                // encode to WAV, and send to the STT service.
                recognitionRequest = nil

                handleFinalTranscription("")
                // handleFinalTranscription sets awaitingDaemonResponse = true (in dictation
                // mode with context), so stopRecording() will keep the overlay visible.
                // This mirrors what the native recognizer's isFinal callback does.
                stopRecording()
                return
            }

            log.info("Recognition task not yet started — cleaning up directly")
            recognitionRequest = nil
            isRecording = false
            currentDictationContext = nil
            activeOrigin = .hotkey
            amplitudeState.reset()
            Self.amplitudeSubject.send(0)
            onAmplitudeChanged?(0)
            audioAccumulator.reset()
            capturedAudioFormat = nil
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

        // In conversation mode with STT-only recording (no recognition task),
        // check if the streaming session produced finals before falling back
        // to batch STT resolution.
        if currentMode == .conversation && recognitionTask == nil && STTProviderRegistry.isServiceConfigured {
            // Signal end-of-recording to the streaming client so it can flush
            // any remaining finals before we check the results.
            //
            // Design note: `client.stop()` is fire-and-forget — the server
            // may not have flushed its final transcript by the time we check
            // `streamingReceivedFinal` below. This is intentional. If streaming
            // has already delivered a `.final` event during the recording
            // session, we use it immediately. If it hasn't (e.g. the stop
            // signal hasn't round-tripped yet), we fall through to the batch
            // STT resolution path below, which re-encodes the full audio and
            // sends it to the STT service. The batch path is the reliable
            // safety net — it always has the complete audio and doesn't depend
            // on WebSocket timing. This avoids adding latency by awaiting the
            // stop signal while still preferring streaming when it's ready.
            if let client = streamingClient, streamingSessionActive {
                Task { await client.stop() }
            }

            // When the streaming session succeeded and delivered finals, use
            // them directly without batch resolution. If streaming hasn't
            // delivered finals yet (race with the fire-and-forget stop above),
            // this check falls through to batch STT — see design note above.
            if streamingReceivedFinal && !streamingFailed {
                let finalText = streamingFinalText.trimmingCharacters(in: .whitespacesAndNewlines)
                if !finalText.isEmpty {
                    log.info("Streaming STT finals available in conversation stop — delivering: \"\(finalText, privacy: .public)\"")
                    isRecording = false
                    onRecordingStateChanged?(false)
                    activeOrigin = .hotkey
                    amplitudeState.reset()
                    Self.amplitudeSubject.send(0)
                    onAmplitudeChanged?(0)
                    audioAccumulator.reset()
                    capturedAudioFormat = nil
                    overlayWindow.dismiss()
                    VoiceFeedback.playDeactivationChime()
                    onTranscription?(streamingFinalText)
                    tearDownAudioState()
                    return
                }
            }

            // Streaming not available, failed, or produced no finals — fall
            // back to batch STT resolution.
            let accumulatedBuffers = audioAccumulator.drain()
            let audioFormat = capturedAudioFormat
            if !accumulatedBuffers.isEmpty, let format = audioFormat {
                log.info("Conversation mode batch fallback — resolving transcription via STT service (\(accumulatedBuffers.count) buffers)")
                let sttClient = self.sttClient
                isRecording = false
                onRecordingStateChanged?(false)
                activeOrigin = .hotkey
                amplitudeState.reset()
                Self.amplitudeSubject.send(0)
                onAmplitudeChanged?(0)
                capturedAudioFormat = nil
                overlayWindow.dismiss()
                tearDownAudioState()

                Task { [weak self] in
                    let resolvedText = await Self.resolveTranscription(
                        nativeText: "",
                        accumulatedBuffers: accumulatedBuffers,
                        audioFormat: format,
                        sttClient: sttClient
                    )
                    guard let self else { return }
                    let trimmed = resolvedText.trimmingCharacters(in: .whitespacesAndNewlines)
                    if !trimmed.isEmpty {
                        VoiceFeedback.playDeactivationChime()
                        self.onTranscription?(resolvedText)
                    } else {
                        log.warning("STT-only conversation transcription empty — prompting for speech recognition")
                        VoiceFeedback.playDeactivationChime()
                        self.showSpeechRecognitionFallbackPrompt()
                    }
                }
                return
            }
        }

        isRecording = false
        onRecordingStateChanged?(false)
        currentDictationContext = nil
        activeOrigin = .hotkey
        amplitudeState.reset()
        Self.amplitudeSubject.send(0)
        onAmplitudeChanged?(0)
        audioAccumulator.reset()
        capturedAudioFormat = nil
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
