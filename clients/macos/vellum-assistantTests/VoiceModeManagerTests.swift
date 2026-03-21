import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

@MainActor
final class VoiceModeManagerTests: XCTestCase {

    private var mockVoiceService: MockVoiceService!
    private var manager: VoiceModeManager!
    private var chatViewModel: ChatViewModel!
    private var daemonClient: GatewayConnectionManager!

    override func setUp() {
        super.setUp()
        mockVoiceService = MockVoiceService()
        manager = VoiceModeManager(voiceService: mockVoiceService)
        daemonClient = GatewayConnectionManager()
        daemonClient.isConnected = true
        chatViewModel = ChatViewModel(daemonClient: daemonClient, eventStreamClient: daemonClient.eventStreamClient)
    }

    override func tearDown() {
        manager.deactivate()
        manager = nil
        mockVoiceService = nil
        chatViewModel = nil
        daemonClient = nil
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
