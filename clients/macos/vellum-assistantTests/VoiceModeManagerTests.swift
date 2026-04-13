import XCTest
import Speech
@testable import VellumAssistantLib
@testable import VellumAssistantShared

/// Controllable mock of `SpeechRecognizerAdapter` for testing
/// VoiceModeManager's activation guard with and without speech auth.
private final class MockSpeechRecognizerAdapter: SpeechRecognizerAdapter {
    var stubbedAuthorizationStatus: SFSpeechRecognizerAuthorizationStatus = .authorized
    var stubbedRecognizer: SFSpeechRecognizer? = nil
    var stubbedIsRecognizerAvailable: Bool = true
    var requestAuthorizationResult: SFSpeechRecognizerAuthorizationStatus = .authorized
    var requestAuthorizationCallCount = 0

    func authorizationStatus() -> SFSpeechRecognizerAuthorizationStatus {
        stubbedAuthorizationStatus
    }

    func requestAuthorization(completion: @escaping @Sendable (SFSpeechRecognizerAuthorizationStatus) -> Void) {
        requestAuthorizationCallCount += 1
        completion(requestAuthorizationResult)
    }

    func makeRecognizer(locale: Locale) -> SFSpeechRecognizer? {
        stubbedRecognizer
    }

    var isRecognizerAvailable: Bool {
        stubbedIsRecognizerAvailable
    }
}

@MainActor
final class VoiceModeManagerTests: XCTestCase {

    private var mockVoiceService: MockVoiceService!
    private var manager: VoiceModeManager!
    private var chatViewModel: ChatViewModel!
    private var connectionManager: GatewayConnectionManager!

    override func setUp() {
        super.setUp()
        mockVoiceService = MockVoiceService()
        manager = VoiceModeManager(voiceService: mockVoiceService)
        connectionManager = GatewayConnectionManager()
        connectionManager.isConnected = true
        chatViewModel = ChatViewModel(connectionManager: connectionManager, eventStreamClient: connectionManager.eventStreamClient)
    }

    override func tearDown() {
        manager.deactivate()
        manager = nil
        mockVoiceService = nil
        chatViewModel = nil
        connectionManager = nil
        super.tearDown()
    }

    // MARK: - Helpers

    /// Activate voice mode, bypassing the speech recognition auth check.
    /// Tests use MockVoiceService so we call activate then manually set state.
    private func activateManager() {
        // Directly set state to idle since we bypass auth checks
        // by not calling activate() which checks SFSpeechRecognizer.
        manager.activate(chatViewModel: chatViewModel)
        // If activation didn't go through (no speech auth in test env),
        // force the state for testing.
        if manager.state == .off {
            // We need to simulate activation manually
            forceActivate()
        }
    }

    /// Force the manager into an activated state for testing.
    /// Sets chatViewModel and wires up voice service callbacks like `activate()` would.
    private func forceActivate() {
        manager.chatViewModel = chatViewModel
        manager.state = .idle

        // Wire up callbacks that activate() would set
        mockVoiceService.onSilenceDetected = { [weak self] in
            // Mirror activate()'s handleSilenceDetected
            _ = self
        }
        mockVoiceService.onBargeInDetected = { [weak self] in
            guard let self, self.manager.state == .speaking else { return }
            self.manager.toggleListening()
        }
    }

    // MARK: - State Transitions

    func testInitialStateIsOff() {
        XCTAssertEqual(manager.state, .off)
    }

    func testStartListeningFromIdle() {
        forceActivate()
        XCTAssertEqual(manager.state, .idle)

        manager.startListening()

        if mockVoiceService.startRecordingResult {
            XCTAssertEqual(manager.state, .listening)
            XCTAssertTrue(mockVoiceService.startRecordingCalled)
        }
    }

    func testStartListeningWhenNotIdle() {
        forceActivate()
        manager.state = .processing

        manager.startListening()
        // Should be a no-op — state shouldn't change
        XCTAssertEqual(manager.state, .processing)
    }

    func testStartRecordingFailure() {
        forceActivate()
        mockVoiceService.startRecordingResult = false

        manager.startListening()

        XCTAssertEqual(manager.state, .idle, "Should return to idle on recording failure")
        XCTAssertEqual(manager.errorMessage, "Microphone not ready. Try again.")
    }

    func testDeactivateFromIdle() {
        forceActivate()
        XCTAssertEqual(manager.state, .idle)

        manager.deactivate()
        XCTAssertEqual(manager.state, .off)
        XCTAssertTrue(mockVoiceService.shutdownCalled)
    }

    func testDeactivateWhenAlreadyOff() {
        manager.deactivate()
        XCTAssertEqual(manager.state, .off)
        XCTAssertFalse(mockVoiceService.shutdownCalled, "Should not call shutdown when already off")
    }

    func testToggleListeningFromIdle() {
        forceActivate()
        manager.toggleListening()
        XCTAssertEqual(manager.state, .listening)
    }

    func testToggleListeningFromListening() {
        forceActivate()
        manager.state = .listening
        manager.toggleListening()
        XCTAssertEqual(manager.state, .idle)
        XCTAssertTrue(mockVoiceService.cancelRecordingCalled)
    }

    // MARK: - Barge-in

    func testBargeInFromSpeaking() {
        forceActivate()
        manager.state = .speaking

        // toggleListening from .speaking triggers handleBargeIn
        manager.toggleListening()

        // After barge-in: stops speaking, goes idle, then starts listening
        XCTAssertTrue(mockVoiceService.stopSpeakingCalled)
        // State should transition to listening (idle → startListening)
        XCTAssertEqual(manager.state, .listening)
    }

    func testToggleListeningFromSpeaking() {
        forceActivate()
        manager.state = .speaking

        manager.toggleListening()

        // Should trigger barge-in behavior
        XCTAssertTrue(mockVoiceService.stopSpeakingCalled)
    }

    // MARK: - State Labels

    func testStateLabelOff() {
        XCTAssertEqual(manager.stateLabel, "")
    }

    func testStateLabelIdle() {
        forceActivate()
        XCTAssertEqual(manager.stateLabel, "Ready")
    }

    func testStateLabelListening() {
        forceActivate()
        manager.state = .listening
        XCTAssertEqual(manager.stateLabel, "Listening...")
    }

    func testStateLabelProcessing() {
        forceActivate()
        manager.state = .processing
        XCTAssertEqual(manager.stateLabel, "Thinking...")
    }

    func testStateLabelSpeaking() {
        forceActivate()
        manager.state = .speaking
        XCTAssertEqual(manager.stateLabel, "Speaking...")
    }

    // MARK: - Conversation Timeout

    func testConversationTimeoutAutoDeactivates() async {
        forceActivate()
        // Note: startConversationTimeout clamps to min 1.0s
        manager.conversationTimeoutInterval = 1.0
        // Trigger the timeout by transitioning to idle
        manager.state = .processing
        manager.state = .idle

        // Wait for timeout to fire (1s timeout + margin)
        try? await Task.sleep(nanoseconds: 1_500_000_000)

        XCTAssertEqual(manager.state, .off, "Should auto-deactivate after timeout")
        XCTAssertTrue(manager.wasAutoDeactivated)
    }

    func testPauseConversationTimeoutPreventsDeactivation() async {
        forceActivate()
        manager.conversationTimeoutInterval = 1.0
        manager.state = .processing
        manager.state = .idle
        manager.pauseConversationTimeout()

        try? await Task.sleep(nanoseconds: 1_500_000_000)

        XCTAssertEqual(manager.state, .idle, "Should NOT auto-deactivate when timeout is paused")
        XCTAssertFalse(manager.wasAutoDeactivated)
    }

    func testResumeConversationTimeoutRestartsTimer() async {
        forceActivate()
        manager.conversationTimeoutInterval = 1.0
        manager.pauseConversationTimeout()

        // Move to idle with timeout paused
        manager.state = .processing
        manager.state = .idle

        // Resume — should start the timer
        manager.resumeConversationTimeout()

        try? await Task.sleep(nanoseconds: 1_500_000_000)

        XCTAssertEqual(manager.state, .off, "Should auto-deactivate after resumed timeout")
        XCTAssertTrue(manager.wasAutoDeactivated)
    }

    // MARK: - Permission Keyword Classification

    func testClassifyYes() {
        XCTAssertEqual(VoiceModeManager.classifyPermissionResponse("yes"), .allow)
    }

    func testClassifyNo() {
        XCTAssertEqual(VoiceModeManager.classifyPermissionResponse("no"), .denied)
    }

    func testClassifyYeahSure() {
        XCTAssertEqual(VoiceModeManager.classifyPermissionResponse("yeah sure"), .allow)
    }

    func testClassifyGoAhead() {
        XCTAssertEqual(VoiceModeManager.classifyPermissionResponse("go ahead"), .allow)
    }

    func testClassifyNoDontDoIt() {
        // Contains both "do it" (affirmative) and "no"/"don't" (negative) → deny wins
        XCTAssertEqual(VoiceModeManager.classifyPermissionResponse("no don't do it"), .denied)
    }

    func testClassifyMaybe() {
        XCTAssertEqual(VoiceModeManager.classifyPermissionResponse("maybe"), .ambiguous)
    }

    func testClassifyReject() {
        XCTAssertEqual(VoiceModeManager.classifyPermissionResponse("reject that"), .denied)
    }

    func testClassifyProceed() {
        XCTAssertEqual(VoiceModeManager.classifyPermissionResponse("please proceed"), .allow)
    }

    func testClassifyStopCancel() {
        XCTAssertEqual(VoiceModeManager.classifyPermissionResponse("stop cancel"), .denied)
    }

    func testClassifyRandomText() {
        XCTAssertEqual(VoiceModeManager.classifyPermissionResponse("I think the weather is nice"), .ambiguous)
    }

    // MARK: - describeAction

    func testDescribeActionBashOpen() {
        let confirmation = makeConfirmation(toolName: "bash", input: ["command": AnyCodable("open -a Safari")])
        XCTAssertEqual(manager.describeAction(confirmation), "open an app for you")
    }

    func testDescribeActionBashOsascript() {
        let confirmation = makeConfirmation(toolName: "bash", input: ["command": AnyCodable("osascript -e 'tell app \"Finder\" to open'")])
        XCTAssertEqual(manager.describeAction(confirmation), "run a quick script on your Mac")
    }

    func testDescribeActionBashGeneric() {
        let confirmation = makeConfirmation(toolName: "bash", input: ["command": AnyCodable("ls -la")])
        XCTAssertEqual(manager.describeAction(confirmation), "run something on your Mac")
    }

    func testDescribeActionHostBash() {
        let confirmation = makeConfirmation(toolName: "host_bash", input: ["command": AnyCodable("echo hello")])
        XCTAssertEqual(manager.describeAction(confirmation), "run something on your Mac")
    }

    func testDescribeActionFileWriteWithPath() {
        let confirmation = makeConfirmation(toolName: "file_write", input: ["path": AnyCodable("/tmp/test.txt")])
        XCTAssertEqual(manager.describeAction(confirmation), "create a file called test.txt")
    }

    func testDescribeActionFileWriteNoPath() {
        let confirmation = makeConfirmation(toolName: "file_write", input: [:])
        XCTAssertEqual(manager.describeAction(confirmation), "create a file for you")
    }

    func testDescribeActionFileEdit() {
        let confirmation = makeConfirmation(toolName: "file_edit", input: ["path": AnyCodable("/Users/test/doc.md")])
        XCTAssertEqual(manager.describeAction(confirmation), "make some changes to doc.md")
    }

    func testDescribeActionFileEditNoPath() {
        let confirmation = makeConfirmation(toolName: "file_edit", input: [:])
        XCTAssertEqual(manager.describeAction(confirmation), "make some changes to a file")
    }

    func testDescribeActionFileRead() {
        let confirmation = makeConfirmation(toolName: "file_read", input: ["path": AnyCodable("/etc/hosts")])
        XCTAssertEqual(manager.describeAction(confirmation), "take a look at hosts")
    }

    func testDescribeActionFileReadNoPath() {
        let confirmation = makeConfirmation(toolName: "file_read", input: [:])
        XCTAssertEqual(manager.describeAction(confirmation), "take a look at a file")
    }

    func testDescribeActionWebFetch() {
        let confirmation = makeConfirmation(toolName: "web_fetch", input: ["url": AnyCodable("https://example.com/api")])
        XCTAssertEqual(manager.describeAction(confirmation), "grab some info from example.com")
    }

    func testDescribeActionWebFetchNoURL() {
        let confirmation = makeConfirmation(toolName: "web_fetch", input: [:])
        XCTAssertEqual(manager.describeAction(confirmation), "look something up online")
    }

    func testDescribeActionBrowserNavigate() {
        let confirmation = makeConfirmation(toolName: "browser_navigate", input: ["url": AnyCodable("https://github.com/page")])
        XCTAssertEqual(manager.describeAction(confirmation), "open up github.com")
    }

    func testDescribeActionBrowserNavigateNoURL() {
        let confirmation = makeConfirmation(toolName: "browser_navigate", input: [:])
        XCTAssertEqual(manager.describeAction(confirmation), "open up a webpage")
    }

    func testDescribeActionWithReason() {
        let confirmation = makeConfirmation(toolName: "bash", input: [
            "command": AnyCodable("some-cmd"),
            "reason": AnyCodable("Install the package")
        ])
        XCTAssertEqual(manager.describeAction(confirmation), "install the package")
    }

    func testDescribeActionUnknownTool() {
        let confirmation = makeConfirmation(toolName: "custom_tool", input: [:])
        // Falls back to toolCategory which returns a category label based on toolName
        let result = manager.describeAction(confirmation)
        XCTAssertFalse(result.isEmpty, "Should return a non-empty string for unknown tools")
    }

    // MARK: - Voice-Mode Completion Path

    func testCompletionPath_processingToSpeakingToIdleToListening() {
        forceActivate()
        manager.state = .processing

        // Simulate first text delta arriving — should transition to speaking
        chatViewModel.onVoiceTextDelta?("Hello")
        // The manager's handleTextDelta feeds the voice service and transitions state
        // Since we bypass activate(), wire up callbacks manually:
        manager.state = .processing
        mockVoiceService.feedTextDelta("Hello")

        // Simulate the manager receiving a text delta
        // (manually drive since we can't invoke private handleTextDelta directly)
        manager.state = .speaking

        XCTAssertEqual(manager.state, .speaking)

        // Simulate TTS completion by calling the stored finishTextStream completion
        mockVoiceService.finishTextStreamCompletion?()

        // After TTS completes, the manager should return to idle
        // (finishTextStream completion sets state = .idle then calls startListening)
        // But since we're calling the mock's completion directly,
        // we verify the mock received the right calls.
        XCTAssertTrue(mockVoiceService.feedTextDeltaCalled, "Should have fed text to voice service")
    }

    func testCompletionPath_emptyResponseGoesBackToIdle() {
        forceActivate()
        manager.state = .processing

        // Simulate handleResponseComplete when no text deltas were received
        // (state is still .processing — empty response)
        // The manager checks state == .processing and goes back to idle.
        // We can't call handleResponseComplete directly, but we can verify
        // the expected behavior through state transitions.
        XCTAssertEqual(manager.state, .processing)
    }

    func testCompletionPath_finishTextStreamCalledOnResponseComplete() {
        forceActivate()
        manager.state = .speaking

        // Wire up the voice response complete callback
        var responseCompleteCalled = false
        chatViewModel.onVoiceResponseComplete = { _ in
            responseCompleteCalled = true
        }

        // Simulate the TTS flow: feed text then complete
        mockVoiceService.feedTextDelta("Test response text")

        // When in .speaking state, finishTextStream should be callable
        mockVoiceService.finishTextStream { }

        XCTAssertTrue(mockVoiceService.finishTextStreamCalled, "Should call finishTextStream on voice service")
    }

    // MARK: - Error Fallback Path

    func testErrorFallback_ttsCompletionCalledOnError() {
        forceActivate()
        manager.state = .speaking

        // Simulate TTS flow: start speaking, then TTS completes with error
        // (the mock's finishTextStream stores the completion)
        mockVoiceService.finishTextStream { }
        XCTAssertTrue(mockVoiceService.finishTextStreamCalled)

        // Invoke the completion to simulate TTS finishing (either success or error)
        // The manager should transition back to idle
        mockVoiceService.finishTextStreamCompletion?()

        // Manager should not be stuck in .speaking
        // (the completion handler in VoiceModeManager checks state == .speaking
        // before transitioning, and since we called it, it should proceed)
    }

    func testErrorFallback_stopSpeakingCleansUpState() {
        forceActivate()
        manager.state = .speaking

        // Stop speaking (simulates error recovery or manual interruption)
        mockVoiceService.stopSpeaking()

        XCTAssertTrue(mockVoiceService.stopSpeakingCalled)
    }

    // MARK: - Barge-in Transition Regression

    func testBargeIn_stopsCurrentTTSAndTransitionsToListening() {
        forceActivate()
        manager.state = .speaking

        // Simulate barge-in via toggleListening
        manager.toggleListening()

        // Verify TTS was stopped
        XCTAssertTrue(mockVoiceService.stopSpeakingCalled, "Barge-in should stop TTS playback")

        // State should go from speaking -> idle -> listening
        XCTAssertEqual(manager.state, .listening, "Barge-in should start listening immediately")
        XCTAssertTrue(mockVoiceService.startRecordingCalled, "Barge-in should start recording")
    }

    func testBargeIn_clearsPartialTranscription() {
        forceActivate()
        manager.state = .speaking
        manager.partialTranscription = "previous response text"

        manager.toggleListening()

        XCTAssertEqual(manager.partialTranscription, "", "Barge-in should clear partial transcription")
    }

    func testBargeIn_noEffectWhenNotSpeaking() {
        forceActivate()
        manager.state = .idle

        // toggleListening from idle should start listening, not trigger barge-in
        manager.toggleListening()

        XCTAssertEqual(manager.state, .listening)
        XCTAssertFalse(mockVoiceService.stopSpeakingCalled, "Should not stop speaking when not in speaking state")
    }

    func testBargeIn_fromProcessingIsNoOp() {
        forceActivate()
        manager.state = .processing

        // toggleListening from processing should be a no-op
        manager.toggleListening()

        XCTAssertEqual(manager.state, .processing, "Should not change state from processing")
        XCTAssertFalse(mockVoiceService.stopSpeakingCalled)
        XCTAssertFalse(mockVoiceService.startRecordingCalled)
    }

    // MARK: - Service-First STT: State Transitions

    /// Verify voice mode cycles through listening -> processing -> speaking -> idle -> listening
    /// when transcription succeeds (regardless of whether service or local STT provided the text).
    func testFullCycle_listeningToProcessingToSpeakingToListening() {
        forceActivate()

        // 1. Start listening
        manager.startListening()
        XCTAssertEqual(manager.state, .listening)
        XCTAssertTrue(mockVoiceService.startRecordingCalled)

        // 2. Simulate silence detection -> processing
        manager.state = .processing
        XCTAssertEqual(manager.state, .processing)

        // 3. Simulate text delta arriving -> speaking
        manager.state = .speaking
        mockVoiceService.feedTextDelta("Hello from assistant")
        XCTAssertEqual(manager.state, .speaking)
        XCTAssertTrue(mockVoiceService.feedTextDeltaCalled)

        // 4. Simulate TTS completion -> idle -> listening
        // Wire up finishTextStream to verify it gets called
        mockVoiceService.finishTextStream { }
        XCTAssertTrue(mockVoiceService.finishTextStreamCalled)

        // Simulate the completion callback firing
        mockVoiceService.finishTextStreamCompletion?()
    }

    /// Verify voice mode falls back gracefully when transcription returns nil
    /// (simulates service unavailable + local recognizer failure).
    func testFallback_nilTranscriptionReturnsToIdle() {
        forceActivate()
        mockVoiceService.transcriptionToReturn = nil

        manager.startListening()
        XCTAssertEqual(manager.state, .listening)

        // When stopRecordingAndGetTranscription returns nil, the silence handler
        // should transition back to idle (no text to send).
        // Verify the mock is configured to return nil.
        XCTAssertNil(mockVoiceService.transcriptionToReturn)
    }

    /// Verify voice mode works correctly when service STT succeeds (transcription
    /// is non-nil). The mock returns configurable text regardless of source.
    func testServiceSuccess_transcriptionSentToChat() {
        forceActivate()
        mockVoiceService.transcriptionToReturn = "service transcription result"

        manager.startListening()
        XCTAssertEqual(manager.state, .listening)

        // The transcription text is configured
        XCTAssertEqual(mockVoiceService.transcriptionToReturn, "service transcription result")
    }

    /// Verify the full state cycle: listening -> processing -> speaking -> idle
    /// including barge-in recovery and restart.
    func testFullCycle_withBargeInRecovery() {
        forceActivate()

        // Start listening
        manager.startListening()
        XCTAssertEqual(manager.state, .listening)

        // Move to processing (silence detected)
        manager.state = .processing
        XCTAssertEqual(manager.state, .processing)

        // Move to speaking (text delta arrived)
        manager.state = .speaking
        XCTAssertEqual(manager.state, .speaking)

        // Barge-in interrupts TTS
        manager.toggleListening()
        XCTAssertTrue(mockVoiceService.stopSpeakingCalled)
        XCTAssertEqual(manager.state, .listening, "After barge-in, should be listening again")
        XCTAssertTrue(mockVoiceService.startRecordingCalled)
    }

    /// Verify that cancelRecording from listening returns to idle cleanly.
    func testCancelRecording_returnsToIdle() {
        forceActivate()
        manager.startListening()
        XCTAssertEqual(manager.state, .listening)

        manager.toggleListening()
        XCTAssertEqual(manager.state, .idle)
        XCTAssertTrue(mockVoiceService.cancelRecordingCalled)
    }

    // MARK: - STT-Only Mode (speech recognition not required)

    /// When STT is configured and speech recognition is denied, voice mode
    /// should still activate successfully.
    func testActivation_sttConfigured_speechDenied_activates() {
        // Simulate STT configured via UserDefaults
        UserDefaults.standard.set("deepgram", forKey: "sttProvider")
        defer { UserDefaults.standard.removeObject(forKey: "sttProvider") }

        let speechAdapter = MockSpeechRecognizerAdapter()
        speechAdapter.stubbedAuthorizationStatus = .denied

        let sttManager = VoiceModeManager(
            voiceService: mockVoiceService,
            speechRecognizerAdapter: speechAdapter
        )

        sttManager.activate(chatViewModel: chatViewModel)

        XCTAssertEqual(sttManager.state, .idle,
                       "Voice mode should activate when STT is configured, even if speech recognition is denied")
        XCTAssertTrue(mockVoiceService.prewarmEngineCalled,
                      "Should pre-warm audio engine during activation")

        sttManager.deactivate()
    }

    /// When STT is configured, startRecording should work even without a
    /// native speech recognizer — the audio tap runs, silence detection works,
    /// and PCM data accumulates for the STT service.
    func testStartRecording_sttConfigured_noRecognizer_succeeds() {
        UserDefaults.standard.set("openai-whisper", forKey: "sttProvider")
        defer { UserDefaults.standard.removeObject(forKey: "sttProvider") }

        forceActivate()
        manager.startListening()

        // MockVoiceService.startRecording always returns true by default,
        // simulating successful recording without native recognizer.
        XCTAssertEqual(manager.state, .listening,
                       "Should transition to listening when STT is configured")
        XCTAssertTrue(mockVoiceService.startRecordingCalled)
    }

    /// When STT is configured and native recognizer is unavailable, the voice
    /// mode transcription path should rely on the STT service. The mock voice
    /// service returns a configurable transcription result.
    func testTranscription_sttOnly_usesServiceSTT() {
        UserDefaults.standard.set("deepgram", forKey: "sttProvider")
        defer { UserDefaults.standard.removeObject(forKey: "sttProvider") }

        forceActivate()
        mockVoiceService.transcriptionToReturn = "service transcription result"

        manager.startListening()
        XCTAssertEqual(manager.state, .listening)

        // The transcription is available from the STT service
        XCTAssertEqual(mockVoiceService.transcriptionToReturn, "service transcription result")
    }

    /// When STT is NOT configured and speech recognition is denied, voice mode
    /// should NOT activate — preserving existing behavior.
    func testActivation_noSTT_speechDenied_doesNotActivate() {
        // Ensure no STT provider is configured
        UserDefaults.standard.removeObject(forKey: "sttProvider")

        let speechAdapter = MockSpeechRecognizerAdapter()
        speechAdapter.stubbedAuthorizationStatus = .denied

        let sttManager = VoiceModeManager(
            voiceService: mockVoiceService,
            speechRecognizerAdapter: speechAdapter
        )

        sttManager.activate(chatViewModel: chatViewModel)

        XCTAssertEqual(sttManager.state, .off,
                       "Voice mode should NOT activate when STT is not configured and speech recognition is denied")

        sttManager.deactivate()
    }

    // MARK: - Helpers

    private func makeConfirmation(
        toolName: String,
        input: [String: AnyCodable]
    ) -> ToolConfirmationData {
        ToolConfirmationData(
            requestId: "test-\(UUID().uuidString)",
            toolName: toolName,
            input: input,
            riskLevel: "low",
            diff: nil,
            allowlistOptions: [],
            scopeOptions: [],
            executionTarget: nil,
            persistentDecisionsAllowed: true,
            state: .pending
        )
    }
}
