import Foundation
import Observation
import Speech
import VellumAssistantShared
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "VoiceModeManager")

@MainActor
protocol LiveVoiceChannelManaging: AnyObject {
    var state: LiveVoiceChannelManager.State { get }
    var partialTranscript: String { get }
    var finalTranscript: String { get }
    var errorMessage: String { get }

    func start(conversationId: String) async
    func interruptSpeakingAndStartListening(conversationId: String) async
    func stopListening() async
    func end() async
}

extension LiveVoiceChannelManager: LiveVoiceChannelManaging {}

/// Voice-mode state model.
///
/// Marked `@Observable` so views reading only `state` are not invalidated by
/// high-frequency writes to `partialTranscription` / `liveTranscription`, and
/// synchronous property mutations inside `handleStateTransition` do not fan
/// out to unrelated observers.
@MainActor
@Observable
final class VoiceModeManager {
    /// Override set via `client_settings_update` from the daemon.
    /// When non-nil, used instead of the default 30-second conversation timeout.
    static var conversationTimeoutOverride: Int?

    enum State: Equatable {
        case off, idle, listening, processing, speaking
    }

    private enum VoicePath {
        case turnBased
        case liveChannel
    }

    var state: State = .off {
        didSet { handleStateTransition(from: oldValue, to: state) }
    }
    var partialTranscription: String = ""
    var liveTranscription: String = ""
    var errorMessage: String = ""
    /// Set to true when deactivation was triggered by the conversation timeout
    /// (as opposed to manual deactivation).
    var wasAutoDeactivated: Bool = false

    /// How long to wait in `.idle` before auto-deactivating voice mode.
    @ObservationIgnored var conversationTimeoutInterval: TimeInterval = 30

    @ObservationIgnored let voiceService: any VoiceServiceProtocol

    /// Adapter for speech recognition authorization checks.
    /// Injected separately from `voiceService` so VoiceModeManager does not
    /// need to know about `OpenAIVoiceService` or any concrete voice service type.
    @ObservationIgnored private let speechRecognizerAdapter: any SpeechRecognizerAdapter
    @ObservationIgnored private let liveVoiceChannelManager: (any LiveVoiceChannelManaging)?
    @ObservationIgnored private let liveVoiceAvailability: @MainActor () -> Bool

    /// Typed accessor for UI views that need observed amplitude properties.
    var openAIVoiceService: OpenAIVoiceService? {
        voiceService as? OpenAIVoiceService
    }

    @ObservationIgnored weak var chatViewModel: ChatViewModel?
    @ObservationIgnored private weak var settingsStore: SettingsStore?
    @ObservationIgnored private var previousOnVoiceResponseComplete: ((String) -> Void)?
    @ObservationIgnored private var previousOnVoiceTextDelta: ((String) -> Void)?
    /// Guards against async auth callback activating after the panel is closed.
    @ObservationIgnored private var awaitingAuthorization = false
    /// Safety timeout to recover from stuck TTS.
    @ObservationIgnored private var ttsTimeoutTask: Task<Void, Never>?
    /// Timer that fires when the conversation has been idle too long.
    @ObservationIgnored private var conversationTimeoutTask: Task<Void, Never>?
    /// When true, `handleStateTransition` will not re-arm the conversation
    /// timeout on transitions to `.idle`. Used during CU escalation so that
    /// `speakTransient`'s completion (which sets state to `.idle`) does not
    /// prematurely restart the 30s timer while the CU session is still running.
    @ObservationIgnored private var conversationTimeoutPaused = false
    /// Permission request IDs currently being handled via voice.
    @ObservationIgnored var pendingPermissionIds: [String] = []
    /// Generation counter controlling the lifetime of the voice-service observation loop.
    @ObservationIgnored private var voiceObservationGeneration: Int = 0
    /// Last observed value from the isThinking observation loop, used to
    /// deduplicate redundant same-value writes and only act on actual transitions.
    @ObservationIgnored private var lastObservedIsThinking: Bool = false
    @ObservationIgnored private var activeVoicePath: VoicePath = .turnBased
    @ObservationIgnored private var liveVoiceObservationGeneration: Int = 0
    @ObservationIgnored private var liveVoiceStartTask: Task<Void, Never>?
    @ObservationIgnored private var liveFallbackAttemptedForSession = false
    @ObservationIgnored private var liveVoicePausedForPermission = false

    init(
        voiceService: any VoiceServiceProtocol = OpenAIVoiceService(),
        liveVoiceChannelManager: (any LiveVoiceChannelManaging)? = nil,
        liveVoiceAvailability: @escaping @MainActor () -> Bool = { false },
        speechRecognizerAdapter: any SpeechRecognizerAdapter = AppleSpeechRecognizerAdapter()
    ) {
        self.voiceService = voiceService
        self.liveVoiceChannelManager = liveVoiceChannelManager
        self.liveVoiceAvailability = liveVoiceAvailability
        self.speechRecognizerAdapter = speechRecognizerAdapter
    }

    var stateLabel: String {
        if !pendingPermissionIds.isEmpty {
            switch state {
            case .speaking: return "Asking permission..."
            case .listening: return "Say yes, no, 10 minutes, or always..."
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
        wasAutoDeactivated = false

        // When an LLM-based STT provider is configured (e.g. Deepgram, OpenAI
        // Whisper), native speech recognition permission is not required — the
        // service handles transcription. Skip the speech auth guard entirely.
        let sttConfigured = STTProviderRegistry.isServiceConfigured
        let liveVoiceEligible = canStartLiveVoiceSession(for: chatViewModel)

        guard liveVoiceEligible || sttConfigured || speechRecognizerAdapter.authorizationStatus() == .authorized else {
            log.error("Voice mode: speech recognition not authorized")
            awaitingAuthorization = true
            let status = speechRecognizerAdapter.authorizationStatus()
            if status == .notDetermined {
                speechRecognizerAdapter.requestAuthorization { [weak self] newStatus in
                    Task { @MainActor in
                        guard let self, self.awaitingAuthorization else { return }
                        self.awaitingAuthorization = false
                        if newStatus == .authorized {
                            log.info("Speech recognition authorized — retrying activation")
                            self.activate(chatViewModel: chatViewModel, settingsStore: settingsStore)
                            self.startListening()
                        } else {
                            log.warning("Speech recognition authorization denied")
                        }
                    }
                }
            } else {
                // Already determined but not authorized (denied/restricted) — nothing to request.
                awaitingAuthorization = false
                log.warning("Speech recognition authorization denied (status: \(status.rawValue))")
            }
            return
        }

        awaitingAuthorization = false
        self.chatViewModel = chatViewModel
        self.settingsStore = settingsStore
        activeVoicePath = .turnBased
        liveFallbackAttemptedForSession = false
        liveVoicePausedForPermission = false

        // Provide the conversation ID to the voice service so the gateway TTS
        // endpoint can resolve the correct provider context.
        if let service = voiceService as? OpenAIVoiceService {
            service.conversationId = chatViewModel.conversationId
        }

        // Keep the user's current model — don't downgrade for voice mode.
        // Capable models (Opus) are much better at tool use (osascript, etc.).

        // Save existing callbacks to restore on deactivation
        previousOnVoiceResponseComplete = chatViewModel.onVoiceResponseComplete
        previousOnVoiceTextDelta = chatViewModel.onVoiceTextDelta

        // Stream text deltas to TTS as they arrive
        chatViewModel.onVoiceTextDelta = { [weak self] delta in
            guard let self, self.activeVoicePath == .turnBased else { return }
            self.handleTextDelta(delta)
        }

        // When the full response is complete, flush remaining text to TTS
        chatViewModel.onVoiceResponseComplete = { [weak self] _ in
            guard let self, self.activeVoicePath == .turnBased else { return }
            self.handleResponseComplete()
        }
        chatViewModel.isVoiceModeActive = true

        // Start observation loops for messages, isThinking, and voice partial text.
        // All loops share voiceObservationGeneration and are invalidated on deactivate.
        startVoiceServiceObservation()
        observeMessages(generation: voiceObservationGeneration, messageManager: chatViewModel.messageManager)
        observeIsThinking(generation: voiceObservationGeneration, messageManager: chatViewModel.messageManager)

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
        log.info("Voice mode activated (daemon + gateway TTS)")
    }

    func deactivate() {
        awaitingAuthorization = false
        guard state != .off else { return }

        // Cancel conversation timeout before setting state to .off
        // (didSet would cancel it too, but be explicit for clarity).
        conversationTimeoutPaused = false
        cancelConversationTimeout()

        // Set state to .off BEFORE shutdown so that any synchronous
        // ttsOnComplete callbacks (from stopSpeaking) won't re-enter
        // startListening() during teardown.
        state = .off

        stopLiveVoiceObservation()
        liveVoiceStartTask?.cancel()
        liveVoiceStartTask = nil
        if let liveVoiceChannelManager {
            Task { @MainActor in
                await liveVoiceChannelManager.end()
            }
        }
        activeVoicePath = .turnBased
        liveFallbackAttemptedForSession = false
        liveVoicePausedForPermission = false

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
        stopVoiceServiceObservation()
        pendingPermissionIds = []

        // Clear the conversation ID from the voice service.
        if let service = voiceService as? OpenAIVoiceService {
            service.conversationId = nil
        }

        chatViewModel = nil
        settingsStore = nil
        state = .off
        partialTranscription = ""
        liveTranscription = ""
        log.info("Voice mode deactivated")
    }

    func toggleListening() {
        switch state {
        case .idle:
            startListening()
        case .listening:
            stopListening()
        case .speaking:
            if activeVoicePath == .liveChannel {
                handleLiveBargeIn()
            } else {
                handleBargeIn()
            }
        default:
            break
        }
    }

    func startListening() {
        guard state == .idle else { return }
        if canStartLiveVoiceSession(for: chatViewModel),
           let conversationId = liveVoiceConversationId(for: chatViewModel) {
            startLiveVoiceListening(conversationId: conversationId)
            return
        }

        startTurnBasedListeningWithAuthorization()
    }

    private func startTurnBasedListeningWithAuthorization() {
        guard STTProviderRegistry.isServiceConfigured || speechRecognizerAdapter.authorizationStatus() == .authorized else {
            requestTurnBasedSpeechAuthorizationThenStart()
            return
        }

        startTurnBasedListening()
    }

    private func startTurnBasedListening() {
        guard state == .idle else { return }
        activeVoicePath = .turnBased
        partialTranscription = ""
        liveTranscription = ""
        errorMessage = ""
        state = .listening
        guard voiceService.startRecording() else {
            log.error("Voice mode: startRecording() failed — mic may not be available yet")
            errorMessage = "Microphone not ready. Try again."
            state = .idle
            return
        }
        log.info("Voice mode: started listening")
    }

    private func stopListening() {
        guard state == .listening else { return }

        if activeVoicePath == .liveChannel {
            state = .processing
            let liveVoiceChannelManager = liveVoiceChannelManager
            Task { @MainActor in
                await liveVoiceChannelManager?.stopListening()
            }
            log.info("Voice mode: released live voice push-to-talk")
            return
        }

        voiceService.cancelRecording()
        state = .idle
        log.info("Voice mode: stopped listening")
    }

    private func requestTurnBasedSpeechAuthorizationThenStart() {
        let status = speechRecognizerAdapter.authorizationStatus()
        guard status == .notDetermined else {
            errorMessage = "Speech recognition permission is required for standard voice mode."
            state = .idle
            log.warning("Voice mode: standard voice fallback unavailable (speech status: \(status.rawValue))")
            return
        }

        awaitingAuthorization = true
        speechRecognizerAdapter.requestAuthorization { [weak self] newStatus in
            Task { @MainActor in
                guard let self, self.awaitingAuthorization, self.state == .idle else { return }
                self.awaitingAuthorization = false
                guard newStatus == .authorized else {
                    self.errorMessage = "Speech recognition permission is required for standard voice mode."
                    log.warning("Voice mode: speech recognition authorization denied during fallback")
                    return
                }
                self.startTurnBasedListening()
            }
        }
    }

    private func liveVoiceConversationId(for chatViewModel: ChatViewModel?) -> String? {
        guard let conversationId = chatViewModel?.conversationId?.trimmingCharacters(in: .whitespacesAndNewlines),
              !conversationId.isEmpty else {
            return nil
        }
        return conversationId
    }

    private func canStartLiveVoiceSession(for chatViewModel: ChatViewModel?) -> Bool {
        liveVoiceChannelManager != nil
            && liveVoiceAvailability()
            && pendingPermissionIds.isEmpty
            && liveVoiceConversationId(for: chatViewModel) != nil
    }

    private func startLiveVoiceListening(conversationId: String) {
        guard let liveVoiceChannelManager else { return }

        activeVoicePath = .liveChannel
        liveFallbackAttemptedForSession = false
        liveVoicePausedForPermission = false
        partialTranscription = ""
        liveTranscription = ""
        errorMessage = ""
        state = .listening
        startLiveVoiceObservation()

        liveVoiceStartTask?.cancel()
        liveVoiceStartTask = Task { @MainActor [weak self, weak liveVoiceChannelManager] in
            guard let self, let liveVoiceChannelManager else { return }
            await liveVoiceChannelManager.start(conversationId: conversationId)
            guard !Task.isCancelled, self.activeVoicePath == .liveChannel else { return }
            self.syncLiveVoiceState(from: liveVoiceChannelManager)
        }
        log.info("Voice mode: starting live voice channel")
    }

    private func startLiveVoiceObservation() {
        liveVoiceObservationGeneration += 1
        observeLiveVoiceLoop(generation: liveVoiceObservationGeneration)
    }

    private func stopLiveVoiceObservation() {
        liveVoiceObservationGeneration += 1
    }

    private func observeLiveVoiceLoop(generation: Int) {
        guard generation == liveVoiceObservationGeneration,
              activeVoicePath == .liveChannel,
              let liveVoiceChannelManager else { return }

        withObservationTracking {
            _ = liveVoiceChannelManager.state
            _ = liveVoiceChannelManager.partialTranscript
            _ = liveVoiceChannelManager.finalTranscript
            _ = liveVoiceChannelManager.errorMessage
        } onChange: { [weak self, weak liveVoiceChannelManager] in
            Task { @MainActor [weak self, weak liveVoiceChannelManager] in
                guard let self,
                      let liveVoiceChannelManager,
                      generation == self.liveVoiceObservationGeneration else { return }
                self.syncLiveVoiceState(from: liveVoiceChannelManager)
                self.observeLiveVoiceLoop(generation: generation)
            }
        }
    }

    private func syncLiveVoiceState(from liveVoiceChannelManager: any LiveVoiceChannelManaging) {
        guard activeVoicePath == .liveChannel, state != .off else { return }

        let visibleTranscript = liveVoiceChannelManager.partialTranscript.isEmpty
            ? liveVoiceChannelManager.finalTranscript
            : liveVoiceChannelManager.partialTranscript
        if liveTranscription != visibleTranscript {
            liveTranscription = visibleTranscript
        }
        if partialTranscription != liveVoiceChannelManager.finalTranscript {
            partialTranscription = liveVoiceChannelManager.finalTranscript
        }

        switch liveVoiceChannelManager.state {
        case .idle:
            state = .idle
        case .connecting, .listening:
            state = .listening
        case .transcribing, .thinking, .ending:
            state = .processing
        case .speaking:
            state = .speaking
        case .failed:
            handleLiveVoiceFailure(message: liveVoiceChannelManager.errorMessage)
        }
    }

    private func handleLiveVoiceFailure(message: String) {
        guard activeVoicePath == .liveChannel else { return }
        stopLiveVoiceObservation()
        liveVoicePausedForPermission = false

        let fallbackMessage = message.isEmpty ? "Live voice is unavailable." : message
        guard !liveFallbackAttemptedForSession else {
            errorMessage = fallbackMessage
            state = .idle
            return
        }

        liveFallbackAttemptedForSession = true
        activeVoicePath = .turnBased
        errorMessage = "Live voice is unavailable. Using standard voice mode."
        state = .idle
        log.warning("Voice mode: live channel failed, falling back to standard voice mode — \(fallbackMessage, privacy: .public)")
        startTurnBasedListeningWithAuthorization()
    }

    private func pauseLiveVoiceForTurnBasedPermission() {
        guard activeVoicePath == .liveChannel else { return }

        stopLiveVoiceObservation()
        liveVoiceStartTask?.cancel()
        liveVoiceStartTask = nil
        activeVoicePath = .turnBased
        liveVoicePausedForPermission = true
    }

    private func resumeLiveVoiceAfterPermissionIfNeeded() {
        guard liveVoicePausedForPermission else { return }
        liveVoicePausedForPermission = false
        guard let liveVoiceChannelManager else { return }

        activeVoicePath = .liveChannel
        startLiveVoiceObservation()
        syncLiveVoiceState(from: liveVoiceChannelManager)
    }

    // MARK: - Silence Detection → Transcription

    private func handleSilenceDetected() {
        guard state == .listening else { return }

        state = .processing
        log.info("Voice mode: silence detected, getting transcription")

        // Reset streaming TTS state for the new turn
        voiceService.resetStreamingTTS()

        Task {
            let text = await voiceService.stopRecordingAndGetTranscription()
            let trimmed = (text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)

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

            chatViewModel.pendingVoiceMessage = true
            chatViewModel.inputText = trimmed
            chatViewModel.sendMessage()
            log.info("Voice mode: sent transcription to chat via daemon")
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
        // because finishTextStream may complete synchronously (e.g. TTS not configured)
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

        let wasUsingLiveVoice = activeVoicePath == .liveChannel
        if wasUsingLiveVoice {
            pauseLiveVoiceForTurnBasedPermission()
        }

        // Stop any current activity before speaking the permission prompt
        switch state {
        case .speaking:
            // Set state to .processing first so ttsOnComplete callback (from stopSpeaking)
            // won't auto-transition to idle/listening
            ttsTimeoutTask?.cancel()
            ttsTimeoutTask = nil
            state = .processing
            if !wasUsingLiveVoice {
                voiceService.stopSpeaking()
            }
        case .listening:
            if wasUsingLiveVoice {
                state = .processing
            } else {
                voiceService.cancelRecording()
            }
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

    func generatePermissionSummary(_ confirmations: [ToolConfirmationData]) -> String {
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
    func describeAction(_ confirmation: ToolConfirmationData) -> String {
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

    /// Classify a voice response into a specific permission decision.
    enum PermissionDecision {
        case allow
        case allowTenMinutes
        case allowConversation
        case alwaysAllow
        case denied
        case ambiguous

        /// The decision string sent to the daemon via HTTP.
        var decisionString: String {
            switch self {
            case .allow: return "allow"
            case .allowTenMinutes: return "allow_10m"
            case .allowConversation: return "allow_conversation"
            case .alwaysAllow: return "always_allow"
            case .denied: return "deny"
            case .ambiguous: return "deny"
            }
        }
    }

    static func classifyPermissionResponse(_ text: String) -> PermissionDecision {
        let lower = text.lowercased()

        let negative = ["no", "nope", "don't", "deny", "stop", "cancel", "reject"]
        let hasNegative = negative.contains(where: { lower.contains($0) })

        // Check specific approval scopes before generic approval.
        // Order matters: more specific patterns first.

        // "allow for 10 minutes" / "10 minutes" / "ten minutes"
        let tenMinPatterns = ["10 minute", "ten minute", "for 10", "for ten"]
        if tenMinPatterns.contains(where: { lower.contains($0) }) && !hasNegative {
            return .allowTenMinutes
        }

        // "allow for this conversation" / "this conversation" / "for the conversation"
        // Also accept "thread" as a legacy synonym for backward compatibility.
        let conversationPatterns = ["this conversation", "the conversation", "for conversation", "allow conversation",
                                    "this thread", "the thread", "for thread", "allow thread"]
        if conversationPatterns.contains(where: { lower.contains($0) }) && !hasNegative {
            return .allowConversation
        }

        // "always allow" / "always approve"
        let alwaysPatterns = ["always allow", "always approve", "allow always"]
        if alwaysPatterns.contains(where: { lower.contains($0) }) && !hasNegative {
            return .alwaysAllow
        }

        // Generic approval
        let affirmative = ["yes", "yeah", "yep", "go ahead", "allow", "approve",
                           "sure", "okay", "ok", "do it", "proceed"]
        let hasAffirmative = affirmative.contains(where: { lower.contains($0) })

        // If both affirmative and negative substrings match (e.g. "no, don't do it"
        // contains "do it" + "no"/"don't"), treat as denial for safety.
        if hasAffirmative && !hasNegative { return .allow }
        if hasNegative { return .denied }
        return .ambiguous
    }

    private func handlePermissionResponse(_ text: String) {
        let decision = Self.classifyPermissionResponse(text)

        guard let chatViewModel else {
            pendingPermissionIds = []
            state = .idle
            return
        }

        switch decision {
        case .allow, .allowTenMinutes, .allowConversation, .alwaysAllow:
            log.info("Voice mode: permissions \(decision.decisionString, privacy: .public) via voice")
            for requestId in pendingPermissionIds {
                chatViewModel.respondToConfirmation(requestId: requestId, decision: decision.decisionString)
            }
            pendingPermissionIds = []
            partialTranscription = ""
            resumeLiveVoiceAfterPermissionIfNeeded()
            state = .processing
        case .denied:
            log.info("Voice mode: permissions denied via voice")
            for requestId in pendingPermissionIds {
                chatViewModel.respondToConfirmation(requestId: requestId, decision: "deny")
            }
            pendingPermissionIds = []
            partialTranscription = ""
            resumeLiveVoiceAfterPermissionIfNeeded()
            state = .processing
        case .ambiguous:
            log.info("Voice mode: unclear permission response — \(text, privacy: .public)")
            state = .speaking
            voiceService.resetStreamingTTS()
            voiceService.feedTextDelta("Sorry, I didn't quite catch that. You can say yes, no, allow for 10 minutes, allow for this conversation, or always allow.")
            voiceService.finishTextStream { [weak self] in
                guard let self else { return }
                self.voiceService.stopBargeInMonitor()
                self.state = .idle
                self.startListening()
            }
        }
    }

    // MARK: - Voice Service Observation

    /// Start observing the voice service's livePartialText. Called during activation.
    private func startVoiceServiceObservation() {
        voiceObservationGeneration += 1
        observeVoiceServiceLoop(generation: voiceObservationGeneration)
    }

    /// Stop observing. Called from deactivate().
    private func stopVoiceServiceObservation() {
        voiceObservationGeneration += 1  // invalidates any in-flight re-arm
    }

    private func observeVoiceServiceLoop(generation: Int) {
        guard generation == voiceObservationGeneration,
              let service = openAIVoiceService else { return }
        withObservationTracking {
            _ = service.livePartialText
        } onChange: { [weak self] in
            Task { @MainActor [weak self] in
                guard let self,
                      generation == self.voiceObservationGeneration else { return }
                // Only update liveTranscription while actively listening.
                // Always re-arm so the loop survives state transitions
                // (e.g., .processing clears partial text but we need to
                // keep observing for the next .listening turn).
                if self.state == .listening,
                   let service = self.openAIVoiceService {
                    self.liveTranscription = service.livePartialText
                }
                self.observeVoiceServiceLoop(generation: generation) // re-arm
            }
        }
    }

    // MARK: - Message & Thinking Observation

    private func observeMessages(generation: Int, messageManager: ChatMessageManager) {
        guard generation == voiceObservationGeneration else { return }
        // Check current state immediately so confirmations already pending
        // before voice activation are spoken without waiting for the next
        // messages mutation.
        checkForConfirmations(in: messageManager.messages)
        withObservationTracking {
            _ = messageManager.messages
        } onChange: { [weak self, weak messageManager] in
            Task { @MainActor [weak self, weak messageManager] in
                guard let self, let messageManager,
                      generation == self.voiceObservationGeneration else { return }
                self.checkForConfirmations(in: messageManager.messages)
                self.observeMessages(generation: generation, messageManager: messageManager)
            }
        }
    }

    private func observeIsThinking(generation: Int, messageManager: ChatMessageManager) {
        guard generation == voiceObservationGeneration else { return }
        // Seed deduplication state so we only act on actual transitions.
        lastObservedIsThinking = messageManager.isThinking
        withObservationTracking {
            _ = messageManager.isThinking
        } onChange: { [weak self, weak messageManager] in
            Task { @MainActor [weak self, weak messageManager] in
                guard let self, let messageManager,
                      generation == self.voiceObservationGeneration else { return }
                let thinking = messageManager.isThinking
                // Deduplicate redundant same-value writes (equivalent to
                // the removed Combine .removeDuplicates()).
                guard thinking != self.lastObservedIsThinking else {
                    self.observeIsThinking(generation: generation, messageManager: messageManager)
                    return
                }
                self.lastObservedIsThinking = thinking
                guard self.state == .idle else {
                    self.observeIsThinking(generation: generation, messageManager: messageManager)
                    return
                }
                if thinking {
                    self.cancelConversationTimeout()
                } else if !self.conversationTimeoutPaused {
                    self.startConversationTimeout()
                }
                self.observeIsThinking(generation: generation, messageManager: messageManager)
            }
        }
    }

    // MARK: - Conversation Timeout

    private func handleStateTransition(from oldState: State, to newState: State) {
        guard oldState != newState else { return }

        if newState == .idle {
            // Don't start the timeout if the agent is currently executing tools —
            // the isThinking observer will restart it when thinking completes.
            // Also skip if the timeout is paused (e.g., during CU escalation).
            if !conversationTimeoutPaused && chatViewModel?.isThinking != true {
                startConversationTimeout()
            }
        } else {
            cancelConversationTimeout()
        }
    }

    private func startConversationTimeout() {
        cancelConversationTimeout()
        // Read the override each time so daemon broadcasts take effect immediately.
        // Fall back to UserDefaults so the user's last-configured value survives
        // app restarts (before the daemon sends a client_settings_update).
        let interval: TimeInterval
        if let override = Self.conversationTimeoutOverride, override > 0 {
            interval = TimeInterval(override)
        } else if let stored = UserDefaults.standard.object(forKey: "voiceConversationTimeoutSeconds") as? Int, stored > 0 {
            interval = TimeInterval(stored)
        } else {
            interval = conversationTimeoutInterval
        }
        let clampedInterval = max(1.0, interval.isFinite ? interval : 30.0)
        conversationTimeoutTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(clampedInterval * 1_000_000_000))
            guard let self, !Task.isCancelled else { return }
            // Only auto-deactivate if we're still in an active session
            guard self.state == .idle, self.chatViewModel != nil else { return }
            log.info("Voice mode: conversation timeout — auto-deactivating")
            self.wasAutoDeactivated = true
            self.deactivate()
        }
    }

    private func cancelConversationTimeout() {
        conversationTimeoutTask?.cancel()
        conversationTimeoutTask = nil
    }

    // MARK: - Transient Speech & Timeout Control

    /// Speak a one-off message using the TTS system without affecting the voice
    /// mode state machine. The message is spoken and then the state returns to
    /// whatever it was before. Callers can use this to provide audible feedback
    /// (e.g., announcing a computer use escalation) without disrupting the
    /// conversation flow.
    func speakTransient(_ message: String) {
        guard state != .off else { return }
        log.info("Voice mode: transient speech — \(message, privacy: .public)")

        // Stop any in-progress recording so the TTS output isn't picked up
        // by the microphone as input.
        if state == .listening {
            voiceService.cancelRecording()
        }

        let previousState = state
        state = .speaking
        voiceService.resetStreamingTTS()
        voiceService.feedTextDelta(message)

        ttsTimeoutTask?.cancel()
        ttsTimeoutTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 15_000_000_000)
            guard let self, !Task.isCancelled, self.state == .speaking else { return }
            log.warning("Voice mode: transient speech timeout, recovering")
            self.voiceService.stopSpeaking()
            self.state = previousState == .listening ? .idle : previousState
        }

        voiceService.finishTextStream { [weak self] in
            guard let self, self.state == .speaking else { return }
            self.ttsTimeoutTask?.cancel()
            self.ttsTimeoutTask = nil
            self.voiceService.stopBargeInMonitor()
            // Return to idle rather than the previous state so the conversation
            // timeout logic is properly re-engaged via handleStateTransition.
            self.state = .idle
        }
    }

    /// Pause the conversation timeout timer. Use this when the assistant is
    /// performing a long-running operation (e.g., computer use) and the
    /// conversation should not auto-deactivate.
    func pauseConversationTimeout() {
        log.info("Voice mode: conversation timeout paused")
        conversationTimeoutPaused = true
        cancelConversationTimeout()
    }

    /// Resume the conversation timeout timer. Call this after a long-running
    /// operation completes so idle auto-deactivation can kick in again.
    func resumeConversationTimeout() {
        log.info("Voice mode: conversation timeout resumed")
        // Clear the paused flag BEFORE the state guard so that when
        // speakTransient finishes and transitions to .idle,
        // handleStateTransition will properly restart the timeout.
        conversationTimeoutPaused = false
        guard state == .idle else { return }
        startConversationTimeout()
    }

    // MARK: - Barge-in (interrupt TTS)

    private func handleLiveBargeIn() {
        guard state == .speaking,
              let liveVoiceChannelManager,
              let conversationId = liveVoiceConversationId(for: chatViewModel) else { return }

        log.info("Voice mode: live barge-in — interrupting TTS")

        ttsTimeoutTask?.cancel()
        ttsTimeoutTask = nil
        liveVoiceStartTask?.cancel()
        partialTranscription = ""
        liveTranscription = ""
        errorMessage = ""
        activeVoicePath = .liveChannel
        state = .listening
        startLiveVoiceObservation()

        liveVoiceStartTask = Task { @MainActor [weak self, weak liveVoiceChannelManager] in
            guard let self, let liveVoiceChannelManager else { return }
            await liveVoiceChannelManager.interruptSpeakingAndStartListening(conversationId: conversationId)
            guard !Task.isCancelled, self.activeVoicePath == .liveChannel else { return }
            self.syncLiveVoiceState(from: liveVoiceChannelManager)
        }
    }

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
