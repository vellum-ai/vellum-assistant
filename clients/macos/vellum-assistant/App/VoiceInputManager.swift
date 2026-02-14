import Foundation
import AppKit
import Speech
import AVFoundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "VoiceInput")

@MainActor
final class VoiceInputManager {
    var onTranscription: ((String) -> Void)?
    var onPartialTranscription: ((String) -> Void)?
    var onRecordingStateChanged: ((Bool) -> Void)?

    private var isRecording = false
    private var globalMonitor: Any?
    private var localMonitor: Any?
    private var globalKeyDownMonitor: Any?
    private var localKeyDownMonitor: Any?
    private var holdTask: Task<Void, Never>?
    private static let holdDelay: UInt64 = 300_000_000 // 300ms in nanoseconds

    private var activationFlag: NSEvent.ModifierFlags? {
        let stored = UserDefaults.standard.string(forKey: "activationKey") ?? "fn"
        switch stored {
        case "ctrl": return .control
        case "none": return nil
        default: return .function // fn and globe are the same physical key
        }
    }

    private let speechRecognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private let audioEngine = AVAudioEngine()

    func start() {
        setupFnKeyMonitors()
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
        stopRecording()
    }

    /// Directly toggle recording on/off — used by UI mic buttons that bypass the Fn-key hold flow.
    func toggleRecording() {
        if isRecording {
            stopRecording()
        } else {
            beginRecording()
        }
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
        guard let flag = activationFlag else { return }
        let keyPressed = event.modifierFlags.contains(flag)
        var otherModifiers: NSEvent.ModifierFlags = [.command, .shift, .control, .option, .function]
        otherModifiers.remove(flag)
        let hasOtherModifiers = !event.modifierFlags.intersection(otherModifiers).isEmpty

        if keyPressed && !hasOtherModifiers && !isRecording {
            // Start a delayed hold — cancelled if key is released quickly (e.g. Fn+arrow combo)
            // or if a regular key is pressed (e.g. Control+C, handled by handleKeyDown)
            holdTask?.cancel()
            holdTask = Task {
                try? await Task.sleep(nanoseconds: Self.holdDelay)
                guard !Task.isCancelled else { return }
                beginRecording()
            }
        } else if keyPressed && hasOtherModifiers {
            // Another modifier pressed while activation key held — cancel pending voice activation
            holdTask?.cancel()
            holdTask = nil
        } else if !keyPressed {
            holdTask?.cancel()
            holdTask = nil
            if isRecording {
                stopRecording()
            }
        }
    }

    private func handleKeyDown() {
        // If user types any key while holding the activation modifier (e.g. Control+C),
        // they're using a keyboard shortcut, not trying to activate voice input.
        // Cancel the pending voice activation timer.
        holdTask?.cancel()
        holdTask = nil
    }

    // MARK: - Recording

    private func beginRecording() {
        guard let speechRecognizer = speechRecognizer, speechRecognizer.isAvailable else {
            log.error("Speech recognizer not available")
            return
        }

        // Don't start if a previous recognition task is still processing
        if recognitionTask != nil {
            log.warning("Previous recognition task still active, skipping")
            return
        }

        // Check microphone access first
        let micStatus = AVCaptureDevice.authorizationStatus(for: .audio)
        if micStatus == .notDetermined {
            AVCaptureDevice.requestAccess(for: .audio) { _ in }
            log.info("Requested microphone authorization — try again after approving")
            return
        }
        if micStatus == .denied || micStatus == .restricted {
            log.warning("Microphone access denied — opening System Settings")
            openPrivacySettings(for: "Privacy_Microphone")
            return
        }

        let authStatus = SFSpeechRecognizer.authorizationStatus()
        if authStatus == .notDetermined {
            SFSpeechRecognizer.requestAuthorization { _ in }
            log.info("Requested speech recognition authorization — try again after approving")
            return
        }
        if authStatus == .denied || authStatus == .restricted {
            log.warning("Speech recognition denied — opening System Settings")
            openPrivacySettings(for: "Privacy_SpeechRecognition")
            return
        }

        isRecording = true
        onRecordingStateChanged?(true)
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
            return
        }

        inputNode.installTap(onBus: 0, bufferSize: 1024, format: recordingFormat) { buffer, _ in
            request.append(buffer)
        }

        recognitionTask = speechRecognizer.recognitionTask(with: request) { [weak self] result, error in
            Task { @MainActor in
                guard let self = self else { return }

                if let result = result {
                    let text = result.bestTranscription.formattedString
                    if result.isFinal {
                        log.info("Transcription: \(text, privacy: .public)")
                        if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                            self.onTranscription?(text)
                        }
                        self.recognitionTask = nil
                    } else {
                        self.onPartialTranscription?(text)
                    }
                }

                if let error = error {
                    log.error("Recognition error: \(error.localizedDescription)")
                    self.recognitionTask = nil
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
            recognitionRequest = nil
            recognitionTask = nil
        }
    }

    private func openPrivacySettings(for pane: String) {
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?\(pane)") {
            NSWorkspace.shared.open(url)
        }
    }

    private func stopRecording() {
        guard isRecording else { return }

        isRecording = false
        onRecordingStateChanged?(false)
        log.info("Voice recording stopped")

        audioEngine.stop()
        audioEngine.inputNode.removeTap(onBus: 0)
        recognitionRequest?.endAudio()
        recognitionRequest = nil
    }
}
