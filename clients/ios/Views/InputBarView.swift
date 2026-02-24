#if canImport(UIKit)
import os
import SwiftUI
import Speech
import AVFoundation
import PhotosUI
import UniformTypeIdentifiers
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
    @ObservedObject var viewModel: ChatViewModel

    @State private var isRecording = false
    @State private var recognitionTask: SFSpeechRecognitionTask?
    @State private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    @State private var audioEngine = AVAudioEngine()
    @State private var showPhotosPicker = false
    @State private var showDocumentPicker = false
    @State private var selectedPhotoItems: [PhotosPickerItem] = []

    var body: some View {
        VStack(spacing: 0) {
            // Attachment strip (shown only when there are pending attachments)
            AttachmentStripView(viewModel: viewModel)

            HStack(spacing: VSpacing.md) {
                // Attachment button — tap opens photo library (most common), long-press shows both options
                Button(action: { showPhotosPicker = true }) {
                    Image(systemName: "paperclip")
                        .font(VFont.body)
                        .foregroundColor(VColor.textSecondary)
                }
                .accessibilityLabel("Attach file")
                .contextMenu {
                    Button {
                        showPhotosPicker = true
                    } label: {
                        Label("Photo Library", systemImage: "photo.on.rectangle")
                    }
                    Button {
                        showDocumentPicker = true
                    } label: {
                        Label("Files", systemImage: "folder")
                    }
                }
                .photosPicker(
                    isPresented: $showPhotosPicker,
                    selection: $selectedPhotoItems,
                    maxSelectionCount: ChatViewModel.maxAttachments,
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
                    .font(VFont.body)
                    .foregroundColor(VColor.textPrimary)
                    .padding(VSpacing.md)
                    .background(VColor.surface)
                    .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))
                    .focused(isInputFocused)
                    .overlay(
                        RoundedRectangle(cornerRadius: VRadius.lg)
                            .stroke(VColor.surfaceBorder, lineWidth: isInputFocused.wrappedValue ? 1.5 : 1)
                    )
                    .animation(VAnimation.fast, value: isInputFocused.wrappedValue)
                    .overlay(
                        RoundedRectangle(cornerRadius: VRadius.lg)
                            .stroke(VColor.surfaceBorder.opacity(0.12), lineWidth: 3)
                            .opacity(isInputFocused.wrappedValue ? 1 : 0)
                            .animation(VAnimation.fast, value: isInputFocused.wrappedValue)
                    )
                    .shadow(color: VColor.textPrimary.opacity(0.06), radius: 8, x: 0, y: 2)

                // Stop button (shown while generating but not yet cancelling)
                if isGenerating && !isCancelling {
                    Button(action: onStop) {
                        ZStack {
                            Circle()
                                .fill(VColor.textPrimary)
                                .frame(width: 32, height: 32)
                            RoundedRectangle(cornerRadius: 3)
                                .fill(VColor.background)
                                .frame(width: 11, height: 11)
                        }
                    }
                    .accessibilityLabel("Stop generation")
                } else {
                    // Mic button
                    Button(action: toggleVoiceInput) {
                        Image(systemName: isRecording ? "mic.fill" : "mic")
                            .font(.system(size: 22))
                            .foregroundColor(isRecording ? .red : VColor.textMuted)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(isRecording ? "Stop voice input" : "Start voice input")

                    // Send button
                    Button(action: {
                        UIImpactFeedbackGenerator(style: .light).impactOccurred()
                        onSend()
                    }) {
                        Image(systemName: "arrow.up.circle.fill")
                            .font(.system(size: 32))
                            .foregroundColor(canSend ? VColor.accent : VColor.textMuted)
                    }
                    .disabled(!canSend)
                    .accessibilityLabel("Send message")
                }
            }
            .padding(VSpacing.md)
            .background(VColor.backgroundSubtle)
        }
    }

    private var canSend: Bool {
        let hasText = !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        let hasAttachments = !viewModel.pendingAttachments.isEmpty
        return (hasText || hasAttachments) && !isGenerating
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
        } else {
            requestPermissionsAndRecord()
        }
    }

    private func requestPermissionsAndRecord() {
        // Request microphone access
        AVAudioApplication.requestRecordPermission { granted in
            guard granted else {
                log.warning("Microphone access denied")
                DispatchQueue.main.async {
                    viewModel.errorText = "Microphone access denied — enable it in Settings > Privacy > Microphone."
                }
                return
            }
            // Request speech recognition access
            SFSpeechRecognizer.requestAuthorization { status in
                DispatchQueue.main.async {
                    guard status == .authorized else {
                        log.warning("Speech recognition not authorized: \(String(describing: status))")
                        viewModel.errorText = "Speech recognition not authorized — enable it in Settings > Privacy > Speech Recognition."
                        return
                    }
                    beginRecording()
                }
            }
        }
    }

    private func beginRecording() {
        guard let recognizer = SFSpeechRecognizer(), recognizer.isAvailable else {
            log.error("Speech recognizer not available")
            viewModel.errorText = "Voice input is not available on this device."
            return
        }

        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.record, mode: .measurement, options: .duckOthers)
            try session.setActive(true, options: .notifyOthersOnDeactivation)
        } catch {
            log.error("Failed to configure AVAudioSession: \(error.localizedDescription)")
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
            viewModel.errorText = "No microphone input available."
            return
        }

        inputNode.installTap(onBus: 0, bufferSize: 1024, format: recordingFormat) { buffer, _ in
            request.append(buffer)
        }

        recognitionTask = recognizer.recognitionTask(with: request) { result, error in
            DispatchQueue.main.async {
                if let result = result {
                    let transcribed = result.bestTranscription.formattedString
                    if result.isFinal {
                        log.info("Voice transcription final: \(transcribed, privacy: .public)")
                        text = transcribed
                        onVoiceResult?(transcribed)
                        stopRecording()
                    }
                }
                if let error = error {
                    // Code 1110 is "no speech detected" — not an error worth logging at error level
                    let nsError = error as NSError
                    if nsError.code != 1110 {
                        log.error("Recognition error: \(error.localizedDescription)")
                    }
                    stopRecording()
                }
            }
        }

        do {
            audioEngine.prepare()
            try audioEngine.start()
            isRecording = true
            log.info("Voice recording started")
        } catch {
            log.error("Audio engine failed to start: \(error.localizedDescription)")
            viewModel.errorText = "Voice input failed: \(error.localizedDescription)"
            // Remove the tap installed above before cleanupRecognition — otherwise the
            // next recording attempt fails trying to install a second tap on bus 0.
            audioEngine.inputNode.removeTap(onBus: 0)
            cleanupRecognition()
        }
    }

    private func stopRecording() {
        guard isRecording else { return }
        log.info("Voice recording stopped")
        audioEngine.stop()
        audioEngine.inputNode.removeTap(onBus: 0)
        recognitionRequest?.endAudio()
        cleanupRecognition()
        isRecording = false
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private func cleanupRecognition() {
        recognitionRequest = nil
        recognitionTask?.cancel()
        recognitionTask = nil
    }
}

struct InputBarView_Previews: PreviewProvider {
    struct PreviewWrapper: View {
        @State private var text = "Hello world"
        @FocusState private var isFocused: Bool

        var body: some View {
            VStack {
                Spacer()
                InputBarView(
                    text: $text,
                    isInputFocused: $isFocused,
                    isGenerating: false,
                    isCancelling: false,
                    onSend: { log.debug("Send tapped") },
                    onStop: { log.debug("Stop tapped") },
                    viewModel: ChatViewModel(daemonClient: DaemonClient(config: .default))
                )
            }
            .background(VColor.background)
        }
    }

    static var previews: some View {
        PreviewWrapper()
    }
}
#endif
