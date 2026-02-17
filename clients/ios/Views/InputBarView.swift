#if canImport(UIKit)
import os
import SwiftUI
import Speech
import AVFoundation
import VellumAssistantShared

private let log = Logger(
    subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant",
    category: "InputBarView"
)

struct InputBarView: View {
    @Binding var text: String
    var isInputFocused: FocusState<Bool>.Binding
    let isGenerating: Bool
    let onSend: () -> Void
    var onVoiceResult: ((String) -> Void)?

    @State private var isRecording = false
    @State private var recognitionTask: SFSpeechRecognitionTask?
    @State private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    @State private var audioEngine = AVAudioEngine()

    var body: some View {
        HStack(spacing: VSpacing.md) {
            // Text field
            TextField("Message...", text: $text, axis: .vertical)
                .textFieldStyle(.plain)
                .font(VFont.body)
                .foregroundColor(VColor.textPrimary)
                .padding(VSpacing.md)
                .background(VColor.surface)
                .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))
                .focused(isInputFocused)

            // Mic button
            Button(action: toggleVoiceInput) {
                Image(systemName: isRecording ? "mic.fill" : "mic")
                    .font(.system(size: 22))
                    .foregroundColor(isRecording ? .red : VColor.textMuted)
            }
            .buttonStyle(.plain)

            // Send button
            Button(action: onSend) {
                Image(systemName: "arrow.up.circle.fill")
                    .font(.system(size: 32))
                    .foregroundColor(canSend ? VColor.accent : VColor.textMuted)
            }
            .disabled(!canSend)
        }
        .padding(VSpacing.md)
        .background(VColor.backgroundSubtle)
    }

    private var canSend: Bool {
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !isGenerating
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
        AVAudioSession.sharedInstance().requestRecordPermission { granted in
            guard granted else {
                log.warning("Microphone access denied")
                return
            }
            // Request speech recognition access
            SFSpeechRecognizer.requestAuthorization { status in
                DispatchQueue.main.async {
                    guard status == .authorized else {
                        log.warning("Speech recognition not authorized: \(String(describing: status))")
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
            return
        }

        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.record, mode: .measurement, options: .duckOthers)
            try session.setActive(true, options: .notifyOthersOnDeactivation)
        } catch {
            log.error("Failed to configure AVAudioSession: \(error.localizedDescription)")
            return
        }

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        recognitionRequest = request

        let inputNode = audioEngine.inputNode
        let recordingFormat = inputNode.outputFormat(forBus: 0)

        guard recordingFormat.channelCount > 0 else {
            log.error("No audio input channels available")
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
                    onSend: { log.debug("Send tapped") }
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
