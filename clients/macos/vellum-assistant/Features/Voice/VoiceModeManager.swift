import Foundation
import Combine
import VellumAssistantShared
import os

private let log = Logger(subsystem: "com.vellum.vellum-assistant", category: "VoiceModeManager")

@MainActor
final class VoiceModeManager: ObservableObject {
    enum State: Equatable {
        case off, idle, listening, processing, speaking
    }

    @Published var state: State = .off
    @Published var partialTranscription: String = ""
    @Published var errorMessage: String = ""

    let voiceService: OpenAIVoiceService

    private weak var chatViewModel: ChatViewModel?
    private weak var settingsStore: SettingsStore?
    private var previousOnVoiceResponseComplete: ((String) -> Void)?
    private var previousOnVoiceTextDelta: ((String) -> Void)?
    /// Safety timeout to recover from stuck TTS.
    private var ttsTimeoutTask: Task<Void, Never>?
    /// Permission request IDs currently being handled via voice.
    private var pendingPermissionIds: [String] = []
    /// Combine subscription to detect new confirmations in chat messages.
    private var messageCancellable: AnyCancellable?

    nonisolated init() {
        self.voiceService = OpenAIVoiceService()
    }

    var hasAPIKey: Bool { voiceService.hasAPIKey }

    var stateLabel: String {
        if !pendingPermissionIds.isEmpty {
            switch state {
            case .speaking: return "Asking permission..."
            case .listening: return "Say yes or no..."
            case .processing: return "Processing approval..."
            default: break
            }
        }
        switch state {
        case .off: return ""
        case .idle: return "Ready"
        case .listening: return "Listening..."
        case .processing: return "Thinking..."
        case .speaking: return "Speaking..."
        }
    }

    func activate(chatViewModel: ChatViewModel, settingsStore: SettingsStore? = nil) {
        guard state == .off else { return }

        guard voiceService.hasAPIKey else {
            log.error("Voice mode: no OpenAI API key configured")
            return
        }

        self.chatViewModel = chatViewModel
        self.settingsStore = settingsStore

        // Keep the user's current model — don't downgrade for voice mode.
        // Capable models (Opus) are much better at tool use (osascript, etc.).

        // Save existing callbacks to restore on deactivation
        previousOnVoiceResponseComplete = chatViewModel.onVoiceResponseComplete
        previousOnVoiceTextDelta = chatViewModel.onVoiceTextDelta

        // Stream text deltas to TTS as they arrive
        chatViewModel.onVoiceTextDelta = { [weak self] delta in
            self?.handleTextDelta(delta)
        }

        // When the full response is complete, flush remaining text to TTS
        chatViewModel.onVoiceResponseComplete = { [weak self] _ in
            self?.handleResponseComplete()
        }
        chatViewModel.isVoiceModeActive = true

        // Monitor for permission requests during voice mode
        messageCancellable = chatViewModel.messageManager.$messages
            .sink { [weak self] messages in
                self?.checkForConfirmations(in: messages)
            }

        // Pre-warm audio engine so first recording starts instantly
        voiceService.prewarmEngine()

        // Set up silence detection callback
        voiceService.onSilenceDetected = { [weak self] in
            self?.handleSilenceDetected()
        }

        // If mic permission is requested and granted, auto-start listening
        voiceService.onMicrophoneAuthorized = { [weak self] in
            guard let self, self.state == .idle else { return }
            self.startListening()
        }

        // Barge-in: user speaks while assistant is talking → interrupt and listen
        voiceService.onBargeInDetected = { [weak self] in
            self?.handleBargeIn()
        }

        state = .idle
        log.info("Voice mode activated (daemon + Haiku + streaming TTS)")
    }

    func deactivate() {
        guard state != .off else { return }

        // Set state to .off BEFORE shutdown so that any synchronous
        // ttsOnComplete callbacks (from stopSpeaking) won't re-enter
        // startListening() during teardown.
        state = .off

        // Fully shut down audio engine to release the microphone
        voiceService.shutdown()

        voiceService.onSilenceDetected = nil
        voiceService.onMicrophoneAuthorized = nil
        voiceService.onBargeInDetected = nil

        if let chatViewModel {
            chatViewModel.onVoiceResponseComplete = previousOnVoiceResponseComplete
            chatViewModel.onVoiceTextDelta = previousOnVoiceTextDelta
            chatViewModel.isVoiceModeActive = false
        }
        previousOnVoiceResponseComplete = nil
        previousOnVoiceTextDelta = nil
        messageCancellable?.cancel()
        messageCancellable = nil
        pendingPermissionIds = []

        chatViewModel = nil
        settingsStore = nil
        state = .off
        partialTranscription = ""
        log.info("Voice mode deactivated")
    }

    func toggleListening() {
        switch state {
        case .idle:
            startListening()
        case .listening:
            stopListening()
        case .speaking:
            handleBargeIn()
        default:
            break
        }
    }

    func startListening() {
        guard state == .idle else { return }
        partialTranscription = ""
        errorMessage = ""
        state = .listening
        voiceService.startRecording()
        log.info("Voice mode: started listening")
    }

    private func stopListening() {
        guard state == .listening else { return }
        voiceService.cancelRecording()
        state = .idle
        log.info("Voice mode: stopped listening")
    }

    // MARK: - Silence Detection → Transcription

    private func handleSilenceDetected() {
        guard state == .listening else { return }

        state = .processing
        log.info("Voice mode: silence detected, transcribing via Whisper")

        // Reset streaming TTS state for the new turn
        voiceService.resetStreamingTTS()

        guard let audioData = voiceService.stopRecordingAndGetAudio() else {
            state = .idle
            return
        }

        Task {
            do {
                let text = try await voiceService.transcribe(audioData)
                let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)

                guard !trimmed.isEmpty, let chatViewModel else {
                    state = .idle
                    return
                }

                // If we're awaiting a permission response, handle it separately
                if !self.pendingPermissionIds.isEmpty {
                    self.partialTranscription = trimmed
                    self.handlePermissionResponse(trimmed)
                    return
                }

                partialTranscription = trimmed

                // Send the transcribed message through the daemon (full context)
                chatViewModel.pendingVoiceMessage = true
                chatViewModel.inputText = trimmed
                chatViewModel.sendMessage()
                log.info("Voice mode: sent transcription to chat via daemon")
            } catch {
                log.error("Transcription failed: \(error.localizedDescription)")
                partialTranscription = ""
                if let voiceError = error as? OpenAIVoiceError {
                    switch voiceError {
                    case .apiError(let statusCode, _):
                        if statusCode == 429 {
                            self.errorMessage = "OpenAI rate limit exceeded. Check your billing at platform.openai.com"
                        } else if statusCode == 401 {
                            self.errorMessage = "Invalid OpenAI API key. Update it in Settings."
                        } else {
                            self.errorMessage = "OpenAI API error (\(statusCode))"
                        }
                    case .noAPIKey:
                        self.errorMessage = "OpenAI API key not configured. Add it in Settings."
                    default:
                        self.errorMessage = "Transcription failed: \(error.localizedDescription)"
                    }
                } else {
                    self.errorMessage = "Transcription failed: \(error.localizedDescription)"
                }
                state = .idle
            }
        }
    }

    // MARK: - Streaming TTS from daemon response

    private func handleTextDelta(_ delta: String) {
        guard state == .processing || state == .speaking else { return }
        guard pendingPermissionIds.isEmpty else { return }

        // Transition to speaking on first delta
        if state == .processing {
            state = .speaking
            log.info("Voice mode: first text delta, starting streaming TTS")
        }

        voiceService.feedTextDelta(delta)
    }

    private func handleResponseComplete() {
        log.info("Voice mode: response complete, flushing remaining TTS")

        // If we never got any text deltas (empty response), go back to idle
        if state == .processing {
            state = .idle
            partialTranscription = ""
            startListening()
            return
        }

        guard state == .speaking else { return }

        // Safety timeout: if TTS completion doesn't fire within 15s, recover
        ttsTimeoutTask?.cancel()
        ttsTimeoutTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 15_000_000_000)
            guard let self, !Task.isCancelled, self.state == .speaking else { return }
            log.warning("Voice mode: TTS timeout, recovering to idle")
            self.voiceService.stopSpeaking()
            self.state = .idle
            self.partialTranscription = ""
            self.startListening()
        }

        // Start monitoring mic for barge-in BEFORE finishTextStream,
        // because finishTextStream may complete synchronously (no ElevenLabs key)
        // and its completion calls startListening() which installs a recording tap.
        // Starting barge-in after that would install a conflicting second tap.
        voiceService.startBargeInMonitor()

        voiceService.finishTextStream { [weak self] in
            guard let self, self.state == .speaking else { return }
            self.ttsTimeoutTask?.cancel()
            self.ttsTimeoutTask = nil
            self.voiceService.stopBargeInMonitor()
            self.state = .idle
            self.partialTranscription = ""
            // Auto-start listening for the next turn
            self.startListening()
        }
    }

    // MARK: - Voice-Driven Permission Handling

    private func checkForConfirmations(in messages: [ChatMessage]) {
        guard pendingPermissionIds.isEmpty else { return }
        guard state == .processing || state == .speaking || state == .idle || state == .listening else { return }

        let pending = messages
            .compactMap { $0.confirmation }
            .filter { $0.state == .pending }

        guard !pending.isEmpty else { return }

        pendingPermissionIds = pending.map { $0.requestId }

        // Stop any current activity before speaking the permission prompt
        switch state {
        case .speaking:
            // Set state to .processing first so ttsOnComplete callback (from stopSpeaking)
            // won't auto-transition to idle/listening
            ttsTimeoutTask?.cancel()
            ttsTimeoutTask = nil
            state = .processing
            voiceService.stopSpeaking()
        case .listening:
            voiceService.cancelRecording()
        default:
            break
        }

        speakPermissionSummary(pending)
    }

    private func speakPermissionSummary(_ confirmations: [ToolConfirmationData]) {
        let summary = generatePermissionSummary(confirmations)
        log.info("Voice mode: asking permission via voice — \(summary, privacy: .public)")

        state = .speaking
        voiceService.resetStreamingTTS()
        voiceService.feedTextDelta(summary)

        ttsTimeoutTask?.cancel()
        ttsTimeoutTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 15_000_000_000)
            guard let self, !Task.isCancelled, self.state == .speaking else { return }
            log.warning("Voice mode: permission TTS timeout, recovering")
            self.voiceService.stopSpeaking()
            self.state = .idle
            self.startListening()
        }

        voiceService.finishTextStream { [weak self] in
            guard let self, self.state == .speaking else { return }
            self.ttsTimeoutTask?.cancel()
            self.ttsTimeoutTask = nil
            self.voiceService.stopBargeInMonitor()
            self.state = .idle
            self.startListening()
        }
    }

    private static let permissionPhrases: [(String) -> String] = [
        { "Sure thing! To do that, I'll need to \($0). Can I go ahead?" },
        { "Yeah let me try! I just need access to \($0). Is that okay?" },
        { "On it! To do what you're asking I need to \($0). Want me to?" },
    ]
    private var lastPhraseIndex = -1

    private func generatePermissionSummary(_ confirmations: [ToolConfirmationData]) -> String {
        let descriptions = confirmations.map { describeAction($0) }
        let unique = Array(Set(descriptions))

        let actions: String
        if unique.count == 1 {
            actions = unique[0]
        } else if unique.count == 2 {
            actions = "\(unique[0]), and then \(unique[1])"
        } else {
            actions = unique.dropLast().joined(separator: ", ") + ", and \(unique.last!)"
        }

        // Rotate through phrases so it doesn't sound repetitive
        var idx = Int.random(in: 0..<Self.permissionPhrases.count)
        if idx == lastPhraseIndex { idx = (idx + 1) % Self.permissionPhrases.count }
        lastPhraseIndex = idx
        return Self.permissionPhrases[idx](actions)
    }

    /// Produce a short, non-technical voice description for a single tool action.
    private func describeAction(_ confirmation: ToolConfirmationData) -> String {
        let reason = (confirmation.input["reason"]?.value as? String) ?? ""

        // If the model provided a reason, use it directly — it's already high-level.
        if !reason.isEmpty {
            return reason.prefix(1).lowercased() + reason.dropFirst()
        }

        // Fall back to tool-specific descriptions
        switch confirmation.toolName {
        case "bash", "host_bash":
            let cmd = (confirmation.input["command"]?.value as? String) ?? ""
            if cmd.hasPrefix("open ") { return "open an app for you" }
            if cmd.contains("osascript") { return "run a quick script on your Mac" }
            return "run something on your Mac"
        case "file_write", "host_file_write":
            let path = (confirmation.input["path"]?.value as? String) ?? ""
            if path.isEmpty { return "create a file for you" }
            return "create a file called \(URL(fileURLWithPath: path).lastPathComponent)"
        case "file_edit", "host_file_edit":
            let path = (confirmation.input["path"]?.value as? String) ?? ""
            if path.isEmpty { return "make some changes to a file" }
            return "make some changes to \(URL(fileURLWithPath: path).lastPathComponent)"
        case "file_read", "host_file_read":
            let path = (confirmation.input["path"]?.value as? String) ?? ""
            if path.isEmpty { return "take a look at a file" }
            return "take a look at \(URL(fileURLWithPath: path).lastPathComponent)"
        case "web_fetch":
            let url = (confirmation.input["url"]?.value as? String) ?? ""
            if let host = URL(string: url)?.host { return "grab some info from \(host)" }
            return "look something up online"
        case "browser_navigate":
            let url = (confirmation.input["url"]?.value as? String) ?? ""
            if let host = URL(string: url)?.host { return "open up \(host)" }
            return "open up a webpage"
        default:
            return confirmation.toolCategory.lowercased()
        }
    }

    private func handlePermissionResponse(_ text: String) {
        let lower = text.lowercased()
        let affirmative = ["yes", "yeah", "yep", "go ahead", "allow", "approve",
                           "sure", "okay", "ok", "do it", "proceed"]
        let negative = ["no", "nope", "don't", "deny", "stop", "cancel", "reject"]

        let hasAffirmative = affirmative.contains(where: { lower.contains($0) })
        let hasNegative = negative.contains(where: { lower.contains($0) })

        // If both affirmative and negative substrings match (e.g. "no, don't do it"
        // contains "do it" + "no"/"don't"), treat as denial for safety.
        let isApproved = hasAffirmative && !hasNegative
        let isDenied = hasNegative

        guard let chatViewModel else {
            pendingPermissionIds = []
            state = .idle
            return
        }

        if isApproved {
            log.info("Voice mode: permissions approved via voice")
            for requestId in pendingPermissionIds {
                chatViewModel.respondToConfirmation(requestId: requestId, decision: "allow")
            }
            pendingPermissionIds = []
            partialTranscription = ""
            state = .processing
        } else if isDenied {
            log.info("Voice mode: permissions denied via voice")
            for requestId in pendingPermissionIds {
                chatViewModel.respondToConfirmation(requestId: requestId, decision: "deny")
            }
            pendingPermissionIds = []
            partialTranscription = ""
            state = .processing
        } else {
            log.info("Voice mode: unclear permission response — \(text, privacy: .public)")
            state = .speaking
            voiceService.resetStreamingTTS()
            voiceService.feedTextDelta("Sorry, I didn't quite catch that. Do you want me to go ahead with that?")
            voiceService.finishTextStream { [weak self] in
                guard let self else { return }
                self.voiceService.stopBargeInMonitor()
                self.state = .idle
                self.startListening()
            }
        }
    }

    // MARK: - Barge-in (interrupt TTS)

    private func handleBargeIn() {
        guard state == .speaking else { return }
        log.info("Voice mode: barge-in — interrupting TTS")

        ttsTimeoutTask?.cancel()
        ttsTimeoutTask = nil
        voiceService.stopSpeaking()
        state = .idle
        partialTranscription = ""
        // Immediately start listening so the user's speech is captured
        startListening()
    }
}
