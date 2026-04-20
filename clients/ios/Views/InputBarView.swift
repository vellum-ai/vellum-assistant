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
    subsystem: Bundle.appBundleIdentifier,
    category: "InputBarView"
)

// Holder class so @StateObject's autoclosure init fires once per view lifetime. With plain
// @State the AVAudioEngine() default is re-evaluated on every struct init, causing rapid
// alloc/dealloc of CoreAudio resources.
@MainActor
private final class AudioEngineHolder: ObservableObject {
    let engine = AVAudioEngine()
}

struct InputBarView: View {
    @Binding var text: String
    var isInputFocused: FocusState<Bool>.Binding
    let isGenerating: Bool
    let isCancelling: Bool
    let onSend: () -> Void
    let onStop: () -> Void
    var onVoiceResult: ((String) -> Void)?
    var viewModel: ChatViewModel

    /// Speech recognizer adapter — defaults to the Apple implementation backed by SFSpeechRecognizer.
    /// Inject a mock for testing.
    var speechRecognizer: any SpeechRecognizerAdapter = AppleSpeechRecognizerAdapter()

    /// STT client for service-first transcription via the gateway. When the service returns a
    /// successful transcription it takes precedence over the native recognizer result; the native
    /// result is used as a fallback when the service is unavailable, unconfigured, or returns an
    /// empty result.
    var sttClient: any STTClientProtocol = STTClient()

    /// Factory that creates a fresh `STTStreamingClientProtocol` for each recording session.
    /// Inject a mock factory for testing.
    var sttStreamingClientFactory: () -> any STTStreamingClientProtocol = { STTStreamingClient() }

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
    /// Cancellation closure returned by the adapter's startRecognitionTask — tears down the
    /// recognition task without requiring a direct SFSpeechRecognitionTask reference.
    @State private var cancelRecognitionTask: (() -> Void)?
    @State private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    @StateObject private var audioEngineHolder = AudioEngineHolder()
    private var audioEngine: AVAudioEngine { audioEngineHolder.engine }
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

    /// Raw PCM audio buffers captured during the recording session. Serialized to WAV and sent
    /// to the STT service for service-first transcription when the session ends.
    @State private var audioBuffers: [Data] = []
    /// The audio format of the recording session, captured when the tap is installed so we can
    /// build a correct WAV header when encoding the collected buffers.
    @State private var recordingSampleRate: Int = 0

    /// Monotonically increasing generation counter that identifies the current STT recording
    /// session. Incremented each time a new recording starts. The async STT resolution task
    /// captures this value at launch and checks it on completion — if it no longer matches,
    /// a newer session has started and the stale result is silently discarded.
    @State private var sttSessionId: Int = 0

    /// True when the current recording session is using STT-only mode (no native speech
    /// recognition task). Set when STT is configured and the native recognizer is unavailable
    /// or unauthorized. In this mode, auto-stop routes directly to the STT service instead
    /// of waiting for a native isFinal callback.
    @State private var isSTTOnlyMode = false

    // MARK: - Streaming STT State

    /// The active streaming STT client for the current recording session. Non-nil when
    /// the session is using real-time streaming transcription. Created fresh per session
    /// via `sttStreamingClientFactory`.
    @State private var activeStreamingClient: (any STTStreamingClientProtocol)?

    /// True when the streaming session has been successfully set up and is receiving events.
    /// When false (stream setup failed or provider doesn't support streaming), the session
    /// falls back to the existing batch STT path.
    @State private var isStreamingActive = false

    /// True once a streaming `.final` event has been received for the current session.
    /// When set, the batch STT resolution path defers to the streaming result instead of
    /// overwriting it.
    @State private var streamingFinalReceived = false

    /// The text value captured at the moment streaming partials began being applied.
    /// Used to detect whether the user has typed in the text field during streaming — if
    /// so, streaming updates are suppressed to avoid overwriting user input.
    @State private var textBeforeStreamingPartials: String = ""

    /// True once `onVoiceResult` has been called for the current recording session.
    /// Prevents duplicate delivery when batch resolution and streaming final race
    /// (e.g. auto-stop fires before `.ready`, then streaming delivers a `.final`
    /// after the batch task has already committed).
    @State private var voiceResultCommitted = false

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
        // The speech recognizer pipeline only has listening and idle states in
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
                    // When STT is configured, only microphone permission is required — don't
                    // mention speech recognition since we can transcribe without it.
                    if STTProviderRegistry.isServiceConfigured {
                        viewModel.errorText = "Microphone not authorized — enable it in Settings > Privacy > Microphone."
                    } else {
                        viewModel.errorText = "Microphone access denied — enable it in Settings > Privacy > Microphone."
                    }
                }
                return
            }

            Task { @MainActor in
                if STTProviderRegistry.isServiceConfigured {
                    // When an STT provider is configured, speech recognition permission is
                    // not required — the STT service handles transcription. Proceed directly
                    // to recording.
                    log.info("STT provider configured — skipping speech recognition authorization")
                    beginRecording()
                } else {
                    // Request speech recognition access via the adapter
                    let status = await speechRecognizer.requestAuthorization()
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

        let sttConfigured = STTProviderRegistry.isServiceConfigured

        // When STT is not configured, the native speech recognizer is required.
        // When STT is configured, the native recognizer is optional — we can fall
        // back to STT-only mode if it's unavailable.
        if !sttConfigured {
            guard speechRecognizer.isAvailable else {
                log.error("Speech recognizer not available")
                isVoiceOrbExpanded = false
                viewModel.errorText = "Voice input is not available on this device."
                return
            }
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

        // Determine whether we can use the native speech recognizer. When STT is
        // configured the native recognizer is optional — if it's unavailable or
        // throws on start, we fall back to STT-only mode (PCM capture + service
        // transcription without a native recognition task).
        var nativeRequest: SFSpeechAudioBufferRecognitionRequest?
        var nativeCancelTask: (() -> Void)?
        var useSTTOnly = false

        if speechRecognizer.isAvailable {
            do {
                let taskResult = try speechRecognizer.startRecognitionTask { result, error in
                    if let result = result {
                        let transcribed = result.transcription
                        if result.isFinal {
                            log.info("Native transcription final: \(transcribed, privacy: .public)")
                            resolveTranscriptWithServiceFirst(nativeTranscript: transcribed)
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
                nativeRequest = taskResult.request
                nativeCancelTask = taskResult.cancel
            } catch {
                if sttConfigured {
                    // Native recognizer failed to start but STT is available — proceed in STT-only mode.
                    log.info("Native recognition task failed to start, using STT-only mode: \(error.localizedDescription)")
                    useSTTOnly = true
                } else {
                    log.error("Failed to start recognition task: \(error.localizedDescription)")
                    isVoiceOrbExpanded = false
                    viewModel.errorText = "Voice input is not available on this device."
                    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
                    return
                }
            }
        } else if sttConfigured {
            // Speech recognizer not available but STT is configured — use STT-only mode.
            log.info("Speech recognizer not available, using STT-only mode")
            useSTTOnly = true
        }
        // else: not available + not configured — guarded above with early return.

        recognitionRequest = nativeRequest
        cancelRecognitionTask = nativeCancelTask
        isSTTOnlyMode = useSTTOnly || nativeRequest == nil

        // Discard any stale hardware format cached on inputNode from a prior session so
        // outputFormat(forBus:) reflects the current route (Bluetooth/wired/AirPods mode
        // switches otherwise raise a format-mismatch NSException in installTap). See
        // AGENTS.md §"AVAudio route-change resilience" and the canonical macOS impl in
        // AudioEngineController.installTapAndStartImpl.
        audioEngine.stop()
        audioEngine.inputNode.removeTap(onBus: 0)
        audioEngine.reset()

        let inputNode = audioEngine.inputNode
        let recordingFormat = inputNode.outputFormat(forBus: 0)

        guard recordingFormat.channelCount > 0 else {
            log.error("No audio input channels available")
            isVoiceOrbExpanded = false
            viewModel.errorText = "No microphone input available."
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
            cleanupRecognition()
            return
        }

        // Reset per-session state for the new recording session.
        sttSessionId += 1
        lastSpeechTime = Date()
        hasSpeechOccurred = false
        isAudioEngineStopped = false
        isAutoStopPending = false
        textAtAutoStop = ""
        audioBuffers = []
        recordingSampleRate = Int(recordingFormat.sampleRate)
        streamingFinalReceived = false
        isStreamingActive = false
        textBeforeStreamingPartials = text
        voiceResultCommitted = false

        // Tear down any leftover streaming client from a previous session.
        if let oldClient = activeStreamingClient {
            activeStreamingClient = nil
            Task { await oldClient.close() }
        }

        // Start streaming STT when the configured provider supports conversation streaming.
        // The streaming client sends partial/final transcript events while audio is being
        // captured. If streaming setup fails, the session falls back to batch STT seamlessly.
        let streamingAvailable = STTProviderRegistry.isStreamingAvailable
        if streamingAvailable {
            let client = sttStreamingClientFactory()
            activeStreamingClient = client
            let sessionAtStart = sttSessionId

            let sampleRateForStream = Int(recordingFormat.sampleRate)

            Task { @MainActor in
                await client.start(
                    mimeType: "audio/pcm",
                    sampleRate: sampleRateForStream,
                    onEvent: { event in
                        self.handleStreamingEvent(event, sessionId: sessionAtStart)
                    },
                    onFailure: { failure in
                        self.handleStreamingFailure(failure, sessionId: sessionAtStart)
                    }
                )
            }
        }

        // Capture the native request locally for the tap closure. In STT-only mode
        // this is nil and the tap only captures PCM data for the service.
        let capturedNativeRequest = nativeRequest

        // installTap throws an Objective-C NSException (not a Swift Error) on
        // format mismatch or stale engine state during audio route changes.
        // Swift's do/catch cannot intercept NSExceptions — they propagate
        // unhandled and call abort(). The ObjC bridge converts them to NSError.
        // See: https://developer.apple.com/documentation/avfaudio/avaudionode/1387122-installtap
        var installError: NSError?
        let installed = VLMPerformWithObjCExceptionHandling({
            inputNode.installTap(onBus: 0, bufferSize: 1024, format: recordingFormat) { buffer, _ in
                // Feed audio buffers to the native recognizer when available.
                capturedNativeRequest?.append(buffer)

                // Capture raw PCM samples for STT service transcription and streaming.
                // Convert float samples to 16-bit integers (WAV/PCM standard).
                if let floatData = buffer.floatChannelData {
                    let frameCount = Int(buffer.frameLength)
                    if frameCount > 0 {
                        var pcmChunk = Data(count: frameCount * MemoryLayout<Int16>.size)
                        pcmChunk.withUnsafeMutableBytes { rawBuffer in
                            let int16Buffer = rawBuffer.bindMemory(to: Int16.self)
                            for i in 0..<frameCount {
                                let clamped = max(-1.0, min(1.0, floatData[0][i]))
                                int16Buffer[i] = Int16(clamped * Float(Int16.max)).littleEndian
                            }
                        }
                        Task { @MainActor in
                            self.audioBuffers.append(pcmChunk)

                            // Stream the PCM chunk to the active streaming client when available.
                            if self.isStreamingActive, let streamClient = self.activeStreamingClient {
                                await streamClient.sendAudio(pcmChunk)
                            }
                        }
                    }
                }

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

        do {
            audioEngine.prepare()
            try audioEngine.start()
            isRecording = true
            log.info("Voice recording started (sttOnly=\(isSTTOnlyMode))")

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
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
            cleanupRecognition()
        }
    }

    /// Resolves the final transcript using service-first precedence: sends captured audio to the
    /// STT gateway service and uses its result when successful. Falls back to the native recognizer
    /// transcript when the service is unavailable, unconfigured, or returns an empty result.
    ///
    /// When streaming has already delivered a final transcript (`streamingFinalReceived`) or the
    /// stream is still active, this method is a no-op — the streaming result takes precedence
    /// over batch.
    private func resolveTranscriptWithServiceFirst(nativeTranscript: String) {
        // If a result was already committed for this session (either by streaming final
        // or a previous batch resolution), skip duplicate delivery.
        guard !voiceResultCommitted else {
            log.info("Voice result already committed for this session — skipping duplicate delivery")
            return
        }

        // If the streaming path already committed a final transcript, do not overwrite it
        // with a batch result.
        guard !streamingFinalReceived else {
            log.info("Streaming final already received — skipping batch STT resolution")
            return
        }

        // If streaming is still active and may deliver a final, defer to it. The streaming
        // final handler will handle completion.
        guard !isStreamingActive else {
            log.info("Streaming still active — deferring to streaming final event")
            return
        }

        // Build WAV payload from captured PCM buffers.
        let capturedBuffers = audioBuffers
        let sampleRate = recordingSampleRate
        let client = sttClient

        // Capture auto-stop state before the async gap — these @State values may change.
        let wasAutoStopPending = isAutoStopPending
        let savedTextAtAutoStop = textAtAutoStop

        // Capture the current session generation so we can detect if a new recording
        // started while this async STT request was in-flight.
        let sessionAtLaunch = sttSessionId

        Task { @MainActor in
            let serviceText = await transcribeViaService(
                buffers: capturedBuffers,
                sampleRate: sampleRate,
                client: client
            )

            // If a new recording session started while the service request was
            // in-flight, discard this stale result to avoid tearing down the new
            // session's state.
            guard sttSessionId == sessionAtLaunch else {
                log.info("STT session \(sessionAtLaunch) superseded by session \(sttSessionId) — discarding stale result")
                return
            }

            // Re-check after the async gap: another concurrent call may have
            // committed while we were awaiting the service response.
            guard !voiceResultCommitted else {
                log.info("Voice result committed by concurrent resolution during await — skipping")
                return
            }

            // Determine which transcript to use: service result if non-empty, else native fallback.
            let finalTranscript: String
            if let serviceText, !serviceText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                log.info("Using STT service transcript (\(serviceText.count) chars)")
                finalTranscript = serviceText
            } else if !nativeTranscript.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                log.info("Falling back to native transcript (\(nativeTranscript.count) chars)")
                finalTranscript = nativeTranscript
            } else if isSTTOnlyMode {
                // STT-only mode and service returned nothing — show error instead
                // of silently delivering empty text.
                log.warning("STT service returned empty result in STT-only mode — no fallback available")
                viewModel.errorText = "Voice transcription failed. Please try again."
                stopRecording()
                isVoiceOrbExpanded = false
                return
            } else {
                log.info("Both service and native transcripts empty")
                finalTranscript = nativeTranscript
            }

            // Only apply the final transcription if the user has not typed anything since auto-stop.
            if !wasAutoStopPending || text == savedTextAtAutoStop {
                text = finalTranscript
                voiceResultCommitted = true
                onVoiceResult?(finalTranscript)
            }
            stopRecording()
            isVoiceOrbExpanded = false
        }
    }

    /// Encodes captured PCM buffers into a WAV file and sends them to the STT service.
    /// Returns the service transcript on success, or nil on any failure/unconfigured/empty result.
    private func transcribeViaService(
        buffers: [Data],
        sampleRate: Int,
        client: any STTClientProtocol
    ) async -> String? {
        guard !buffers.isEmpty, sampleRate > 0 else {
            log.info("No audio buffers captured — skipping STT service call")
            return nil
        }

        // Concatenate all PCM chunks and encode as WAV. Run off the main actor to avoid
        // blocking the UI with the data copy.
        // Always encode as mono (channels: 1) because the PCM capture only reads
        // floatData[0] (the first channel) — even when the recording format is stereo.
        let wavData: Data = await Task.detached(priority: .userInitiated) {
            var pcmData = Data()
            for chunk in buffers {
                pcmData.append(chunk)
            }
            let format = AudioWavEncoder.Format(
                sampleRate: sampleRate,
                channels: 1,
                bitsPerSample: 16
            )
            return AudioWavEncoder.encode(pcmData: pcmData, format: format)
        }.value

        let result = await client.transcribe(audioData: wavData)
        switch result {
        case .success(let text):
            return text
        case .notConfigured:
            log.info("STT service not configured — will use native fallback")
            return nil
        case .serviceUnavailable:
            log.warning("STT service unavailable — will use native fallback")
            return nil
        case .error(let statusCode, let message):
            log.warning("STT service error (status=\(String(describing: statusCode))): \(message) — will use native fallback")
            return nil
        }
    }

    // MARK: - Streaming Event Handling

    /// Handles events from the STT streaming WebSocket session.
    ///
    /// - `ready`: marks the stream as active so audio chunks begin flowing.
    /// - `partial`: applies interim transcript text to the composer binding.
    /// - `final`: commits the final transcript, taking precedence over batch STT.
    /// - `error`/`closed`: the stream is done; batch fallback will handle completion.
    private func handleStreamingEvent(_ event: STTStreamEvent, sessionId: Int) {
        // Stale-session guard: discard events from a superseded recording session.
        guard sttSessionId == sessionId else {
            log.info("Streaming event for stale session \(sessionId) (current: \(sttSessionId)) — ignoring")
            return
        }

        switch event {
        case .ready:
            isStreamingActive = true
            log.info("STT streaming session ready — streaming audio chunks")

        case .partial(let partialText, let seq):
            // Only apply partials if the stream is active and the user has not manually
            // typed since the last partial was applied.
            guard isStreamingActive, text == textBeforeStreamingPartials else { return }
            log.debug("STT streaming partial (seq=\(seq)): \(partialText.prefix(80), privacy: .public)")
            text = partialText
            // Track the latest partial as the baseline for user-typing detection.
            textBeforeStreamingPartials = partialText

        case .final(let finalText, let seq):
            log.info("STT streaming final (seq=\(seq), \(finalText.count) chars)")
            streamingFinalReceived = true
            // Skip if a result was already committed (e.g. batch resolution won the race).
            guard !voiceResultCommitted else {
                log.info("Voice result already committed — skipping streaming final delivery")
                stopRecording()
                isVoiceOrbExpanded = false
                return
            }
            // During auto-stop the user may have typed in the text field while waiting
            // for the streaming final. Only apply the streaming result when the text has
            // not been edited since auto-stop began (same guard as the batch path).
            if isAutoStopPending && text != textAtAutoStop {
                log.info("User edited text during auto-stop — discarding streaming final")
                stopRecording()
                isVoiceOrbExpanded = false
                return
            }
            text = finalText
            textBeforeStreamingPartials = finalText
            voiceResultCommitted = true
            onVoiceResult?(finalText)
            // Tear down the session — the streaming final is the authoritative result.
            stopRecording()
            isVoiceOrbExpanded = false

        case .error(let category, let message, let seq):
            log.warning("STT streaming error (seq=\(seq), category=\(category)): \(message)")
            // Stream errored — fall back to batch. Clear streaming state so batch
            // resolution proceeds normally.
            isStreamingActive = false
            // If auto-stop was waiting on a streaming final that never arrived,
            // trigger batch fallback now to avoid a stuck session.
            if !streamingFinalReceived && isAutoStopPending && !voiceResultCommitted {
                resolveTranscriptWithServiceFirst(nativeTranscript: "")
            }

        case .closed:
            log.info("STT streaming session closed")
            isStreamingActive = false
            // If auto-stop was waiting on a streaming final that never arrived,
            // trigger batch fallback now to avoid a stuck session.
            if !streamingFinalReceived && isAutoStopPending && !voiceResultCommitted {
                resolveTranscriptWithServiceFirst(nativeTranscript: "")
            }
        }
    }

    /// Handles streaming session failure (connection error, timeout, rejected, etc.).
    /// Falls back to the batch STT path for the current recording session.
    private func handleStreamingFailure(_ failure: STTStreamFailure, sessionId: Int) {
        guard sttSessionId == sessionId else { return }
        log.warning("STT streaming failed: \(String(describing: failure)) — falling back to batch STT")
        isStreamingActive = false
        activeStreamingClient = nil
        // If auto-stop was waiting on a streaming final that never arrived,
        // trigger batch fallback now to avoid a stuck session.
        if !streamingFinalReceived && isAutoStopPending && !voiceResultCommitted {
            resolveTranscriptWithServiceFirst(nativeTranscript: "")
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
        cleanupStreaming()
        isRecording = false
        isAutoStopPending = false
        isSTTOnlyMode = false
        micAmplitude = 0
        audioBuffers = []
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

        // Signal the streaming client that recording has stopped so it can flush
        // any remaining finals from the server before closing.
        if let streamClient = activeStreamingClient, isStreamingActive {
            Task { await streamClient.stop() }
        }

        // In STT-only mode there is no native recognition task to deliver a final
        // transcript via the isFinal callback. Route directly to the STT service.
        // However, if streaming is active, the streaming final event will handle
        // completion — skip the batch fallback to avoid duplicate resolution.
        if isSTTOnlyMode && !isStreamingActive {
            resolveTranscriptWithServiceFirst(nativeTranscript: "")
        }
    }

    private func cleanupRecognition() {
        recognitionRequest = nil
        cancelRecognitionTask?()
        cancelRecognitionTask = nil
    }

    /// Tears down the streaming STT client for the current session. Safe to call
    /// even when no streaming client is active.
    private func cleanupStreaming() {
        isStreamingActive = false
        streamingFinalReceived = false
        if let client = activeStreamingClient {
            activeStreamingClient = nil
            Task { await client.close() }
        }
    }
}

#endif
