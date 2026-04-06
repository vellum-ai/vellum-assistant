#if canImport(UIKit)
import os
import SwiftUI
import Speech
import AVFoundation
import PhotosUI
import UniformTypeIdentifiers
import ObjCExceptionCatcher
import VellumAssistantShared

private let log = Logger(
    subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant",
    category: "InputBarView"
)

struct InputBarView: View {
    @Binding var text: String
    var isInputFocused: FocusState<Bool>.Binding
    let isGenerating: Bool
    let isCancelling: Bool
    let onSend: () -> Void
    let onStop: () -> Void
    var onVoiceResult: ((String) -> Void)?
    var viewModel: ChatViewModel

    @State private var isRecording = false
    /// True after the audio engine and tap have been torn down (set by finishRecordingForAutoStop
    /// and stopRecording). Prevents double-stop when the auto-stop path and the isFinal callback
    /// both reach teardown code.
    @State private var isAudioEngineStopped = false
    /// True while the auto-stop path is waiting for the isFinal callback to arrive. During this
    /// window the voice orb is already collapsed and the text field is visible, so the user may
    /// start typing. textAtAutoStop captures the text value the moment auto-stop fires; the isFinal
    /// handler only applies the final transcription when text still matches that snapshot, i.e.
    /// the user has not typed anything in the interim.
    @State private var isAutoStopPending = false
    @State private var textAtAutoStop: String = ""
    @State private var recognitionTask: SFSpeechRecognitionTask?
    @State private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    @State private var audioEngine = AVAudioEngine()
    @State private var showPhotosPicker = false
    @State private var showDocumentPicker = false
    @State private var selectedPhotoItems: [PhotosPickerItem] = []
    /// Timer that fires after the listening timeout to auto-stop recording.
    @State private var listeningTimeoutTimer: Timer?
    /// Timer that drives silence detection by comparing last-speech time to the threshold.
    @State private var silenceTimer: Timer?
    /// Tracks the last time meaningful audio amplitude was observed.
    @State private var lastSpeechTime: Date = .distantPast
    /// Set to true once audible speech has been detected during the current recording.
    @State private var hasSpeechOccurred = false

    // Voice settings read from UserDefaults — updated live without restart.
    @AppStorage(UserDefaultsKeys.voiceListeningTimeout) private var listeningTimeout: Double = 30.0
    @AppStorage(UserDefaultsKeys.voiceSilenceThreshold) private var silenceThreshold: Double = 1.0

    /// Current audio input amplitude [0,1] — updated while recording for the orb animation.
    @State private var micAmplitude: Float = 0
    /// Tracks whether the orb panel is expanded (voice orb replaces the normal input row).
    @State private var isVoiceOrbExpanded = false
    /// Set to true when Cancel is tapped before recording has started; checked by beginRecording()
    /// so that a cancel during the mic-permission or setup window aborts the session.
    @State private var isCancelledBeforeRecording = false

    var body: some View {
        VStack(spacing: 0) {
            // Attachment strip (shown only when there are pending attachments)
            AttachmentStripView(viewModel: viewModel)

            // Voice orb panel — replaces the text input row while recording
            if isVoiceOrbExpanded {
                voiceOrbPanel
                    .transition(.asymmetric(
                        insertion: .move(edge: .bottom).combined(with: .opacity),
                        removal: .move(edge: .bottom).combined(with: .opacity)
                    ))
            } else {
                standardInputRow
                    .transition(.asymmetric(
                        insertion: .move(edge: .bottom).combined(with: .opacity),
                        removal: .move(edge: .bottom).combined(with: .opacity)
                    ))
            }
        }
        .animation(VAnimation.standard, value: isVoiceOrbExpanded)
    }

    // MARK: - Voice Orb Panel

    private var voiceOrbPanel: some View {
        VStack(spacing: VSpacing.sm) {
            VoiceOrbView(
                state: voiceOrbState,
                listeningAmplitude: micAmplitude
            )

            // Dismiss / stop button — tapping cancels recording and collapses the orb.
            // If tapped before recording has started (e.g. during the mic-permission dialog),
            // isCancelledBeforeRecording signals beginRecording() to abort setup immediately.
            Button(action: {
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
                isCancelledBeforeRecording = true
                stopRecording()
                isVoiceOrbExpanded = false
            }) {
                Text("Cancel")
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentTertiary)
            }
            .buttonStyle(.plain)
            .padding(.bottom, VSpacing.xs)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, VSpacing.lg)
        .background(VColor.surfaceBase)
    }

    private var voiceOrbState: VoiceOrbState {
        // The SFSpeechRecognizer pipeline only has listening and idle states in
        // this simplified implementation; thinking/processing is not separately
        // observable here, so we reflect the recording flag directly.
        isRecording ? .listening : .idle
    }

    // MARK: - Standard Input Row

    private var standardInputRow: some View {
        HStack(spacing: VSpacing.md) {
            // Attachment button — tap opens photo library (most common), long-press shows both options
            VButton(
                label: "Attach file",
                iconOnly: VIcon.paperclip.rawValue,
                style: .ghost,
                action: { showPhotosPicker = true }
            )
            .contextMenu {
                Button {
                    showPhotosPicker = true
                } label: {
                    Label { Text("Photo Library") } icon: { VIconView(.image, size: 14) }
                }
                Button {
                    showDocumentPicker = true
                } label: {
                    Label { Text("Files") } icon: { VIconView(.folder, size: 14) }
                }
            }
            .photosPicker(
                isPresented: $showPhotosPicker,
                selection: $selectedPhotoItems,
                matching: .images
            )
            .fileImporter(
                isPresented: $showDocumentPicker,
                allowedContentTypes: [.item],
                allowsMultipleSelection: true
            ) { result in
                handleFileImportResult(result)
            }
            .onChange(of: selectedPhotoItems) { _, newItems in
                handlePhotoSelection(newItems)
            }

            // Text field
            TextField("Message...", text: $text, axis: .vertical)
                .textFieldStyle(.plain)
                .font(VFont.bodyMediumLighter)
                .foregroundStyle(VColor.contentDefault)
                .padding(VSpacing.md)
                .background(VColor.surfaceBase)
                .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))
                .focused(isInputFocused)
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.lg)
                        .stroke(VColor.borderBase, lineWidth: isInputFocused.wrappedValue ? 1.5 : 1)
                )
                .animation(VAnimation.fast, value: isInputFocused.wrappedValue)
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.lg)
                        .stroke(VColor.borderBase.opacity(0.12), lineWidth: 3)
                        .opacity(isInputFocused.wrappedValue ? 1 : 0)
                        .animation(VAnimation.fast, value: isInputFocused.wrappedValue)
                )
                .shadow(color: VColor.contentDefault.opacity(0.06), radius: 8, x: 0, y: 2)

            // Stop button (shown while generating but not yet cancelling)
            if isGenerating && !isCancelling {
                VButton(
                    label: "Stop generation",
                    iconOnly: VIcon.square.rawValue,
                    style: .primary,
                    action: onStop
                )
            } else {
                // Mic button — tap to expand the animated voice orb
                VButton(
                    label: "Start voice input",
                    iconOnly: VIcon.mic.rawValue,
                    style: .ghost,
                    action: toggleVoiceInput
                )

                // Send button
                VButton(
                    label: "Send message",
                    iconOnly: VIcon.arrowUp.rawValue,
                    style: .primary,
                    action: {
                        UIImpactFeedbackGenerator(style: .light).impactOccurred()
                        onSend()
                    }
                )
                .disabled(!canSend)
            }
        }
        .padding(VSpacing.md)
        .background(VColor.surfaceBase)
    }

    private var canSend: Bool {
        let hasText = !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        let hasAttachments = !viewModel.pendingAttachments.isEmpty
        // Block send while an attachment is still loading so the attachment
        // isn't dropped from the message if the user taps Send too quickly.
        return (hasText || hasAttachments) && !isGenerating && !viewModel.isLoadingAttachment
    }

    private func handlePhotoSelection(_ items: [PhotosPickerItem]) {
        guard !items.isEmpty else { return }
        // Clear selection state so the same photos can be re-selected later
        selectedPhotoItems = []
        for item in items {
            item.loadTransferable(type: Data.self) { result in
                switch result {
                case .success(let data):
                    guard let data else { return }
                    Task { @MainActor in
                        viewModel.addAttachment(imageData: data, filename: "Photo.jpeg")
                    }
                case .failure(let error):
                    log.error("Failed to load photo: \(error.localizedDescription)")
                    Task { @MainActor in
                        viewModel.errorText = "Could not load photo."
                    }
                }
            }
        }
    }

    private func handleFileImportResult(_ result: Result<[URL], Error>) {
        switch result {
        case .success(let urls):
            for url in urls {
                // Security-scoped resource access is required for files from the Files app
                let didStartAccessing = url.startAccessingSecurityScopedResource()
                defer {
                    if didStartAccessing { url.stopAccessingSecurityScopedResource() }
                }
                viewModel.addAttachment(url: url)
            }
        case .failure(let error):
            log.error("File import failed: \(error.localizedDescription)")
            viewModel.errorText = "Could not import file."
        }
    }

    // MARK: - Voice Input

    private func toggleVoiceInput() {
        if isRecording {
            stopRecording()
            isVoiceOrbExpanded = false
        } else {
            // Expand the orb panel immediately so the user sees it before permissions are checked.
            // Reset the cancel flag for this new session before the async permission flow begins.
            isCancelledBeforeRecording = false
            isVoiceOrbExpanded = true
            requestPermissionsAndRecord()
        }
    }

    private func requestPermissionsAndRecord() {
        // Request microphone access
        AVAudioApplication.requestRecordPermission { granted in
            guard granted else {
                log.warning("Microphone access denied")
                DispatchQueue.main.async {
                    isVoiceOrbExpanded = false
                    viewModel.errorText = "Microphone access denied — enable it in Settings > Privacy > Microphone."
                }
                return
            }
            // Request speech recognition access
            SFSpeechRecognizer.requestAuthorization { status in
                DispatchQueue.main.async {
                    guard status == .authorized else {
                        log.warning("Speech recognition not authorized: \(String(describing: status))")
                        isVoiceOrbExpanded = false
                        viewModel.errorText = "Speech recognition not authorized — enable it in Settings > Privacy > Speech Recognition."
                        return
                    }
                    beginRecording()
                }
            }
        }
    }

    private func beginRecording() {
        // If the user tapped Cancel while permissions were being requested, abort here
        // rather than starting a session they've already dismissed.
        guard !isCancelledBeforeRecording else {
            log.info("Recording cancelled before it started — aborting setup")
            return
        }

        guard let recognizer = SFSpeechRecognizer(), recognizer.isAvailable else {
            log.error("Speech recognizer not available")
            isVoiceOrbExpanded = false
            viewModel.errorText = "Voice input is not available on this device."
            return
        }

        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.record, mode: .measurement, options: .duckOthers)
            try session.setActive(true, options: .notifyOthersOnDeactivation)
        } catch {
            log.error("Failed to configure AVAudioSession: \(error.localizedDescription)")
            isVoiceOrbExpanded = false
            viewModel.errorText = "Could not start voice input: \(error.localizedDescription)"
            return
        }

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        recognitionRequest = request

        let inputNode = audioEngine.inputNode
        let recordingFormat = inputNode.outputFormat(forBus: 0)

        guard recordingFormat.channelCount > 0 else {
            log.error("No audio input channels available")
            isVoiceOrbExpanded = false
            viewModel.errorText = "No microphone input available."
            return
        }

        // Reset per-session state for the new recording session.
        lastSpeechTime = Date()
        hasSpeechOccurred = false
        isAudioEngineStopped = false
        isAutoStopPending = false
        textAtAutoStop = ""

        // installTap throws an Objective-C NSException (not a Swift Error) on
        // format mismatch or stale engine state during audio route changes.
        // Swift's do/catch cannot intercept NSExceptions — they propagate
        // unhandled and call abort(). The ObjC bridge converts them to NSError.
        // See: https://developer.apple.com/documentation/avfaudio/avaudionode/1387122-installtap
        var installError: NSError?
        let installed = VLMPerformWithObjCExceptionHandling({
            inputNode.installTap(onBus: 0, bufferSize: 1024, format: recordingFormat) { buffer, _ in
                request.append(buffer)

                // Compute RMS amplitude for both voice orb animation and silence detection.
                guard let floatData = buffer.floatChannelData else { return }
                let frameCount = Int(buffer.frameLength)
                guard frameCount > 0 else { return }
                var sum: Float = 0
                for i in 0..<frameCount {
                    let s = floatData[0][i]
                    sum += s * s
                }
                let rms = (sum / Float(frameCount)).squareRoot()

                Task { @MainActor in
                    // Drive the orb animation with the scaled amplitude.
                    micAmplitude = min(rms * 5, 1.0)

                    // Update last-speech timestamp whenever the mic picks up audible signal
                    // (used by the silence detection timer to decide when to auto-stop).
                    if rms > 0.015 {
                        self.lastSpeechTime = Date()
                        self.hasSpeechOccurred = true
                    }
                }
            }
        }, &installError)
        guard installed else {
            log.error("installTap threw ObjC exception: \(installError?.localizedDescription ?? "unknown")")
            isVoiceOrbExpanded = false
            viewModel.errorText = "Voice input failed. Please try again."
            // Remove any partially-installed tap before cleanup — otherwise the
            // next recording attempt fails trying to install a second tap on bus 0.
            audioEngine.inputNode.removeTap(onBus: 0)
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
            cleanupRecognition()
            return
        }

        recognitionTask = recognizer.recognitionTask(with: request) { result, error in
            DispatchQueue.main.async {
                if let result = result {
                    let transcribed = result.bestTranscription.formattedString
                    if result.isFinal {
                        log.info("Voice transcription final: \(transcribed, privacy: .public)")
                        // Only apply the final transcription if the user has not typed anything
                        // since auto-stop. When isAutoStopPending is true the voice orb has already
                        // collapsed and the text field is visible, so the user may have started
                        // editing; we respect their input by skipping the overwrite in that case.
                        if !isAutoStopPending || text == textAtAutoStop {
                            text = transcribed
                            onVoiceResult?(transcribed)
                        }
                        stopRecording()
                        isVoiceOrbExpanded = false
                    }
                }
                if let error = error {
                    // Code 1110 is "no speech detected" — not an error worth logging at error level
                    let nsError = error as NSError
                    if nsError.code != 1110 {
                        log.error("Recognition error: \(error.localizedDescription)")
                    }
                    stopRecording()
                    isVoiceOrbExpanded = false
                }
            }
        }

        do {
            audioEngine.prepare()
            try audioEngine.start()
            isRecording = true
            log.info("Voice recording started")

            // Silence detection timer: polls every 0.25 s to check how long
            // the mic has been quiet. Stops recording once the threshold is met
            // and at least some speech has occurred (avoids cutting off immediately).
            let capturedThreshold = silenceThreshold
            silenceTimer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { _ in
                DispatchQueue.main.async {
                    guard self.isRecording, self.hasSpeechOccurred else { return }
                    let silenceDuration = Date().timeIntervalSince(self.lastSpeechTime)
                    if silenceDuration >= capturedThreshold {
                        log.info("Silence threshold reached (\(capturedThreshold, privacy: .public)s), stopping recording")
                        // Use finishRecordingForAutoStop so the recognizer can deliver a
                        // final transcript before the session is fully torn down.
                        self.finishRecordingForAutoStop()
                        self.isVoiceOrbExpanded = false
                    }
                }
            }

            // Listening timeout: hard upper bound on recording duration.
            let capturedTimeout = listeningTimeout
            listeningTimeoutTimer = Timer.scheduledTimer(withTimeInterval: capturedTimeout, repeats: false) { _ in
                DispatchQueue.main.async {
                    guard self.isRecording else { return }
                    log.info("Listening timeout (\(capturedTimeout, privacy: .public)s), stopping recording")
                    // Use finishRecordingForAutoStop so the recognizer can deliver a
                    // final transcript before the session is fully torn down.
                    self.finishRecordingForAutoStop()
                    self.isVoiceOrbExpanded = false
                }
            }
        } catch {
            log.error("Audio engine failed to start: \(error.localizedDescription)")
            viewModel.errorText = "Voice input failed: \(error.localizedDescription)"
            isVoiceOrbExpanded = false
            // Remove the tap installed above before cleanupRecognition — otherwise the
            // next recording attempt fails trying to install a second tap on bus 0.
            audioEngine.inputNode.removeTap(onBus: 0)
            cleanupRecognition()
        }
    }

    private func stopRecording() {
        guard isRecording else { return }
        log.info("Voice recording stopped")

        // Cancel auto-stop timers before tearing down the session.
        listeningTimeoutTimer?.invalidate()
        listeningTimeoutTimer = nil
        silenceTimer?.invalidate()
        silenceTimer = nil

        // Only tear down the audio engine if finishRecordingForAutoStop hasn't already done so.
        if !isAudioEngineStopped {
            audioEngine.stop()
            audioEngine.inputNode.removeTap(onBus: 0)
            recognitionRequest?.endAudio()
            isAudioEngineStopped = true
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        }
        cleanupRecognition()
        isRecording = false
        isAutoStopPending = false
        micAmplitude = 0
    }

    private func finishRecordingForAutoStop() {
        // isAudioEngineStopped guards against both timers queuing async blocks that both
        // pass the isRecording check before either executes — the second call would otherwise
        // call audioEngine.stop() and endAudio() a second time on the same session.
        guard isRecording, !isAudioEngineStopped else { return }
        log.info("Voice recording finishing (auto-stop) — awaiting final transcription")

        // Disarm auto-stop timers so they don't fire again.
        listeningTimeoutTimer?.invalidate()
        listeningTimeoutTimer = nil
        silenceTimer?.invalidate()
        silenceTimer = nil

        // Snapshot the current text so the isFinal callback can detect whether the user has
        // typed anything in the text field while we were waiting for the final result.
        isAutoStopPending = true
        textAtAutoStop = text

        // Stop the audio engine and signal end-of-audio to the recognizer.
        // Do NOT cancel the recognition task and do NOT clear isRecording — the existing
        // isFinal callback in the recognition task will call stopRecording() to complete
        // teardown once the final transcript is delivered. isAudioEngineStopped prevents
        // stopRecording() from tearing down the engine a second time.
        audioEngine.stop()
        audioEngine.inputNode.removeTap(onBus: 0)
        recognitionRequest?.endAudio()
        isAudioEngineStopped = true
        micAmplitude = 0
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private func cleanupRecognition() {
        recognitionRequest = nil
        recognitionTask?.cancel()
        recognitionTask = nil
    }
}

#endif
