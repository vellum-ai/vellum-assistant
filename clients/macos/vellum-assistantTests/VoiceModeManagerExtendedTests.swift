import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

/// Extended tests for `VoiceModeManager` covering permission summary generation,
/// conversation timeout edge cases, state transition guards, and transient speech.
/// Complements the existing `VoiceModeManagerTests.swift`.
@MainActor
final class VoiceModeManagerExtendedTests: XCTestCase {

    private var mockVoiceService: MockVoiceService!
    private var manager: VoiceModeManager!
    private var chatViewModel: ChatViewModel!
    private var daemonClient: DaemonClient!

    override func setUp() {
        super.setUp()
        mockVoiceService = MockVoiceService()
        manager = VoiceModeManager(voiceService: mockVoiceService)
        let cm = GatewayConnectionManager()
        daemonClient = DaemonClient(connectionManager: cm)
        daemonClient.isConnected = true
        chatViewModel = ChatViewModel(daemonClient: daemonClient, eventStreamClient: cm.eventStreamClient)
    }

    override func tearDown() {
        manager.deactivate()
        manager = nil
        mockVoiceService = nil
        chatViewModel = nil
        daemonClient = nil
        super.tearDown()
    }

    /// Force the manager into an activated state for testing.
    private func forceActivate() {
        manager.chatViewModel = chatViewModel
        manager.state = .idle
    }

    private func makeConfirmation(
        toolName: String,
        input: [String: AnyCodable] = [:]
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

    // MARK: - generatePermissionSummary

    func testPermissionSummarySingleAction() {
        forceActivate()
        let confirmations = [makeConfirmation(toolName: "bash", input: ["command": AnyCodable("ls")])]
        let summary = manager.generatePermissionSummary(confirmations)

        // Should contain the action description
        XCTAssertTrue(summary.contains("run something on your Mac"),
                      "Summary should include the action description, got: \(summary)")
    }

    func testPermissionSummaryTwoActions() {
        forceActivate()
        let confirmations = [
            makeConfirmation(toolName: "bash", input: ["command": AnyCodable("ls")]),
            makeConfirmation(toolName: "file_write", input: ["path": AnyCodable("/tmp/test.txt")])
        ]
        let summary = manager.generatePermissionSummary(confirmations)

        // Two actions should be joined with ", and then"
        XCTAssertTrue(summary.contains(", and then") || summary.contains(", and "),
                      "Two actions should be joined naturally, got: \(summary)")
    }

    func testPermissionSummaryDeduplicatesIdenticalActions() {
        forceActivate()
        // Two identical bash commands should produce only one description
        let confirmations = [
            makeConfirmation(toolName: "bash", input: ["command": AnyCodable("ls")]),
            makeConfirmation(toolName: "bash", input: ["command": AnyCodable("ls")])
        ]
        let summary = manager.generatePermissionSummary(confirmations)

        // Should NOT contain ", and then" since after dedup there's only one unique action
        XCTAssertFalse(summary.contains(", and then"),
                       "Identical actions should be deduplicated, got: \(summary)")
    }

    func testPermissionSummaryThreeActions() {
        forceActivate()
        let confirmations = [
            makeConfirmation(toolName: "bash", input: ["command": AnyCodable("open -a Safari")]),
            makeConfirmation(toolName: "file_write", input: ["path": AnyCodable("/tmp/test.txt")]),
            makeConfirmation(toolName: "web_fetch", input: ["url": AnyCodable("https://example.com")])
        ]
        let summary = manager.generatePermissionSummary(confirmations)

        // Three actions use Oxford comma format: "a, b, and c"
        XCTAssertTrue(summary.contains(", and "),
                      "Three actions should use Oxford comma format, got: \(summary)")
    }

    func testPermissionSummaryUsesVariedPhrases() {
        forceActivate()
        let confirmations = [makeConfirmation(toolName: "bash", input: ["command": AnyCodable("ls")])]

        // Generate multiple summaries and verify we get at least 2 different phrases
        var phrases = Set<String>()
        for _ in 0..<10 {
            let summary = manager.generatePermissionSummary(confirmations)
            // Extract the first few words to identify the phrase template
            let prefix = String(summary.prefix(20))
            phrases.insert(prefix)
        }

        XCTAssertGreaterThan(phrases.count, 1,
                             "Should rotate through different phrase templates")
    }

    // MARK: - Permission Classification Edge Cases

    func testClassifyEmptyString() {
        XCTAssertEqual(VoiceModeManager.classifyPermissionResponse(""), .ambiguous)
    }

    func testClassifyYesWithNoise() {
        XCTAssertEqual(VoiceModeManager.classifyPermissionResponse("umm yes I think so"), .allow)
    }

    func testClassifyOkayVariant() {
        XCTAssertEqual(VoiceModeManager.classifyPermissionResponse("okay fine"), .allow)
    }

    func testClassifyNopeDont() {
        XCTAssertEqual(VoiceModeManager.classifyPermissionResponse("nope don't do that"), .denied)
    }

    func testClassifyAllowIt() {
        XCTAssertEqual(VoiceModeManager.classifyPermissionResponse("allow it"), .allow)
    }

    func testClassifyApproveIt() {
        XCTAssertEqual(VoiceModeManager.classifyPermissionResponse("I approve"), .allow)
    }

    func testClassifyStopIt() {
        XCTAssertEqual(VoiceModeManager.classifyPermissionResponse("stop"), .denied)
    }

    func testClassifyMixedSignalsDefaultToDeny() {
        // "yes but also stop" — has both affirmative and negative → denied for safety
        XCTAssertEqual(VoiceModeManager.classifyPermissionResponse("yes but stop"), .denied)
    }

    // MARK: - describeAction Edge Cases

    func testDescribeActionReasonLowercasesFirstLetter() {
        let confirmation = makeConfirmation(toolName: "bash", input: [
            "command": AnyCodable("some-cmd"),
            "reason": AnyCodable("Install the package")
        ])
        let result = manager.describeAction(confirmation)
        XCTAssertEqual(result, "install the package",
                       "Should lowercase first letter of reason")
    }

    func testDescribeActionHostVariants() {
        // host_ prefixed tools should behave identically to their non-host versions
        let hostBash = makeConfirmation(toolName: "host_bash", input: ["command": AnyCodable("echo hi")])
        let hostFileWrite = makeConfirmation(toolName: "host_file_write", input: ["path": AnyCodable("/tmp/f.txt")])
        let hostFileEdit = makeConfirmation(toolName: "host_file_edit", input: ["path": AnyCodable("/tmp/f.txt")])
        let hostFileRead = makeConfirmation(toolName: "host_file_read", input: ["path": AnyCodable("/tmp/f.txt")])

        XCTAssertEqual(manager.describeAction(hostBash), "run something on your Mac")
        XCTAssertEqual(manager.describeAction(hostFileWrite), "create a file called f.txt")
        XCTAssertEqual(manager.describeAction(hostFileEdit), "make some changes to f.txt")
        XCTAssertEqual(manager.describeAction(hostFileRead), "take a look at f.txt")
    }

    // MARK: - Conversation Timeout Clamping

    func testConversationTimeoutClampedToMinimum() async {
        forceActivate()
        manager.conversationTimeoutInterval = 0.1 // Below 1.0s minimum
        manager.state = .processing
        manager.state = .idle

        // Wait 1.5s — if clamped to 1.0s, it should fire
        try? await Task.sleep(nanoseconds: 1_500_000_000)
        XCTAssertEqual(manager.state, .off, "Should deactivate after clamped 1.0s timeout")
    }

    func testConversationTimeoutNonFiniteClampedToDefault() async {
        forceActivate()
        manager.conversationTimeoutInterval = .infinity
        manager.state = .processing
        manager.state = .idle

        // Non-finite should clamp to 30s default, so after 1.5s it should still be idle
        try? await Task.sleep(nanoseconds: 1_500_000_000)
        XCTAssertEqual(manager.state, .idle, "Non-finite timeout should clamp to 30s, not fire immediately")
    }

    // MARK: - State Transition Guards

    func testStartListeningOnlyFromIdle() {
        forceActivate()
        manager.state = .processing

        manager.startListening()

        XCTAssertEqual(manager.state, .processing,
                       "startListening should be no-op when not in idle state")
    }

    func testToggleListeningFromProcessingIsNoOp() {
        forceActivate()
        manager.state = .processing

        manager.toggleListening()

        XCTAssertEqual(manager.state, .processing)
    }

    func testToggleListeningFromOffIsNoOp() {
        manager.toggleListening()
        XCTAssertEqual(manager.state, .off)
    }

    // MARK: - Transient Speech

    func testSpeakTransientFromOffIsNoOp() {
        manager.speakTransient("hello")
        XCTAssertEqual(manager.state, .off, "speakTransient should no-op when voice mode is off")
        XCTAssertFalse(mockVoiceService.feedTextDeltaCalled)
    }

    func testSpeakTransientFromIdleTransitionsToSpeaking() {
        forceActivate()
        manager.speakTransient("escalating to computer use")

        XCTAssertEqual(manager.state, .speaking)
        XCTAssertTrue(mockVoiceService.feedTextDeltaCalled)
        XCTAssertEqual(mockVoiceService.fedTextDeltas.last, "escalating to computer use")
    }

    func testSpeakTransientFromListeningCancelsRecording() {
        forceActivate()
        manager.state = .listening

        manager.speakTransient("hold on")

        XCTAssertTrue(mockVoiceService.cancelRecordingCalled,
                      "Should cancel recording before speaking")
        XCTAssertEqual(manager.state, .speaking)
    }

    func testSpeakTransientCompletionReturnsToIdle() {
        forceActivate()
        manager.speakTransient("done")

        // Simulate TTS completion
        mockVoiceService.finishTextStreamCompletion?()

        XCTAssertEqual(manager.state, .idle,
                       "Should return to idle after transient speech completes")
    }

    // MARK: - Pause/Resume Timeout Interaction

    func testPausedTimeoutDoesNotFireOnIdleTransition() async {
        forceActivate()
        manager.conversationTimeoutInterval = 1.0
        manager.pauseConversationTimeout()

        manager.state = .processing
        manager.state = .idle

        try? await Task.sleep(nanoseconds: 1_500_000_000)

        XCTAssertEqual(manager.state, .idle,
                       "Timeout should not fire when paused")
    }

    func testResumeTimeoutAfterPause() async {
        forceActivate()
        manager.conversationTimeoutInterval = 1.0
        manager.pauseConversationTimeout()

        manager.state = .processing
        manager.state = .idle

        manager.resumeConversationTimeout()

        try? await Task.sleep(nanoseconds: 1_500_000_000)

        XCTAssertEqual(manager.state, .off,
                       "Should deactivate after resumed timeout")
    }

    func testResumeTimeoutWhenNotIdleDoesNotStartTimer() async {
        forceActivate()
        manager.conversationTimeoutInterval = 1.0
        manager.pauseConversationTimeout()
        manager.state = .processing

        manager.resumeConversationTimeout()

        // Should not start timer since we're in .processing, not .idle
        try? await Task.sleep(nanoseconds: 1_500_000_000)

        XCTAssertEqual(manager.state, .processing,
                       "Should not start timeout when not idle")
    }

    // MARK: - State Labels with Pending Permissions

    func testStateLabelSpeakingWithPendingPermission() {
        forceActivate()
        manager.state = .speaking
        manager.pendingPermissionIds = ["req-1"]
        XCTAssertEqual(manager.stateLabel, "Asking permission...")
    }

    func testStateLabelListeningWithPendingPermission() {
        forceActivate()
        manager.state = .listening
        manager.pendingPermissionIds = ["req-1"]
        XCTAssertEqual(manager.stateLabel, "Say yes or no...")
    }

    func testStateLabelProcessingWithPendingPermission() {
        forceActivate()
        manager.state = .processing
        manager.pendingPermissionIds = ["req-1"]
        XCTAssertEqual(manager.stateLabel, "Processing approval...")
    }

    func testStateLabelIdleWithPendingPermissionFallsThrough() {
        forceActivate()
        manager.state = .idle
        manager.pendingPermissionIds = ["req-1"]
        XCTAssertEqual(manager.stateLabel, "Ready",
                       "Idle with pending permissions should fall through to normal label")
    }

    // MARK: - Barge-in

    func testBargeInFromSpeakingStopsSpeakingAndStartsListening() {
        forceActivate()
        manager.state = .speaking

        manager.toggleListening()

        XCTAssertTrue(mockVoiceService.stopSpeakingCalled)
        XCTAssertEqual(manager.state, .listening)
    }

    func testBargeInClearsTTSTimeout() {
        forceActivate()
        manager.state = .speaking

        manager.toggleListening()

        // After barge-in, the TTS timeout should be cancelled.
        // We verify indirectly: if it weren't cancelled, a late timeout
        // would set state to .idle then .listening again, which would be wrong.
        XCTAssertEqual(manager.state, .listening)
    }

    // MARK: - wasAutoDeactivated

    func testManualDeactivateDoesNotSetAutoFlag() {
        forceActivate()
        manager.deactivate()
        XCTAssertFalse(manager.wasAutoDeactivated)
    }

    func testAutoDeactivateViaTimeoutSetsFlag() async {
        forceActivate()
        manager.conversationTimeoutInterval = 1.0
        manager.state = .processing
        manager.state = .idle

        try? await Task.sleep(nanoseconds: 1_500_000_000)

        XCTAssertTrue(manager.wasAutoDeactivated)
    }

    // MARK: - Deactivation Idempotency

    func testDeactivateWhenOffIsNoOp() {
        manager.deactivate()
        XCTAssertEqual(manager.state, .off)
        XCTAssertFalse(mockVoiceService.shutdownCalled)
    }

    func testDoubleDeactivateIsIdempotent() {
        forceActivate()
        manager.deactivate()
        mockVoiceService.reset()

        manager.deactivate()
        XCTAssertFalse(mockVoiceService.shutdownCalled,
                       "Second deactivate should not call shutdown")
    }
}

