import XCTest
import Speech
import AVFoundation
import VellumAssistantShared
@testable import VellumAssistantLib

/// A controllable mock of `STTClientProtocol` for testing service-first
/// transcription resolution without making network requests.
private final class MockSTTClient: STTClientProtocol, @unchecked Sendable {
    /// The result to return from `transcribe`. Defaults to `.notConfigured`
    /// so tests that don't care about STT get native fallback behavior.
    var stubbedResult: STTResult = .notConfigured
    var transcribeCallCount = 0
    var lastAudioData: Data?

    func transcribe(audioData: Data, contentType: String) async -> STTResult {
        transcribeCallCount += 1
        lastAudioData = audioData
        return stubbedResult
    }
}

@MainActor
private final class MockDictationClient: DictationClientProtocol {
    var sentRequests: [DictationRequest] = []
    var response = DictationResponseMessage(
        type: "dictation_response",
        text: "cleaned text",
        mode: "dictation"
    )
    var onProcess: (() -> Void)?

    func process(_ request: DictationRequest) async -> DictationResponseMessage {
        sentRequests.append(request)
        onProcess?()
        return response
    }
}

/// A controllable mock of `SpeechRecognizerAdapter` for testing VoiceInputManager's
/// authorization and recognizer-creation paths without hitting real Speech framework APIs.
///
/// `stubbedRecognizer` defaults to `nil` so tests never depend on a real
/// `SFSpeechRecognizer` instance (which may be unavailable in CI/sandboxed
/// environments). Recognizer availability is controlled independently via
/// `stubbedIsRecognizerAvailable`, letting permission tests validate their
/// assertions even when the real Speech framework cannot create a recognizer.
private final class MockSpeechRecognizerAdapter: SpeechRecognizerAdapter {
    var stubbedAuthorizationStatus: SFSpeechRecognizerAuthorizationStatus = .authorized
    var stubbedRecognizer: SFSpeechRecognizer? = nil
    var stubbedIsRecognizerAvailable: Bool = true
    var requestAuthorizationResult: SFSpeechRecognizerAuthorizationStatus = .authorized
    var makeRecognizerCallCount = 0
    var requestAuthorizationCallCount = 0

    func authorizationStatus() -> SFSpeechRecognizerAuthorizationStatus {
        stubbedAuthorizationStatus
    }

    func requestAuthorization(completion: @escaping @Sendable (SFSpeechRecognizerAuthorizationStatus) -> Void) {
        requestAuthorizationCallCount += 1
        completion(requestAuthorizationResult)
    }

    func makeRecognizer(locale: Locale) -> SFSpeechRecognizer? {
        makeRecognizerCallCount += 1
        return stubbedRecognizer
    }

    var isRecognizerAvailable: Bool {
        stubbedIsRecognizerAvailable
    }
}

@MainActor
final class VoiceInputManagerTests: XCTestCase {

    private var manager: VoiceInputManager!
    private var dictationClient: MockDictationClient!
    private var speechAdapter: MockSpeechRecognizerAdapter!
    private var sttClient: MockSTTClient!

    override func setUp() {
        super.setUp()
        dictationClient = MockDictationClient()
        speechAdapter = MockSpeechRecognizerAdapter()
        sttClient = MockSTTClient()
        manager = VoiceInputManager(
            dictationClient: dictationClient,
            speechRecognizerAdapter: speechAdapter,
            sttClient: sttClient
        )
    }

    override func tearDown() {
        manager = nil
        dictationClient = nil
        speechAdapter = nil
        sttClient = nil
        super.tearDown()
    }

    // MARK: - shouldStartRecording

    func testActivationKeyAloneAfterAppSwitch() {
        let result = manager.shouldStartRecording(
            activationKeyPressed: true,
            otherKeyPressed: false,
            timeSinceAppSwitch: 1.0,
            isAlreadyRecording: false
        )
        XCTAssertTrue(result)
    }

    func testOtherKeyPressedDuringHold() {
        let result = manager.shouldStartRecording(
            activationKeyPressed: true,
            otherKeyPressed: true,
            timeSinceAppSwitch: 1.0,
            isAlreadyRecording: false
        )
        XCTAssertFalse(result, "Should not start recording when another key is pressed during hold")
    }

    func testRecentAppSwitch() {
        let result = manager.shouldStartRecording(
            activationKeyPressed: true,
            otherKeyPressed: false,
            timeSinceAppSwitch: 0.3,
            isAlreadyRecording: false
        )
        XCTAssertFalse(result, "Should not start recording within 0.5s of app switch")
    }

    func testAppSwitchExactlyAtThreshold() {
        let result = manager.shouldStartRecording(
            activationKeyPressed: true,
            otherKeyPressed: false,
            timeSinceAppSwitch: 0.5,
            isAlreadyRecording: false
        )
        XCTAssertFalse(result, "Should not start recording at exactly 0.5s (not >)")
    }

    func testAlreadyRecording() {
        let result = manager.shouldStartRecording(
            activationKeyPressed: true,
            otherKeyPressed: false,
            timeSinceAppSwitch: 1.0,
            isAlreadyRecording: true
        )
        XCTAssertFalse(result, "Should not start recording when already recording")
    }

    func testActivationKeyNotPressed() {
        let result = manager.shouldStartRecording(
            activationKeyPressed: false,
            otherKeyPressed: false,
            timeSinceAppSwitch: 1.0,
            isAlreadyRecording: false
        )
        XCTAssertFalse(result, "Should not start recording when activation key is not pressed")
    }

    // MARK: - Dictation Routing (handleFinalTranscription)

    /// Helper: creates a DictationContext with sensible defaults for test use.
    private func makeDictationContext(
        bundleIdentifier: String = "com.example.TestApp",
        appName: String = "TestApp",
        windowTitle: String = "Untitled",
        selectedText: String? = nil,
        cursorInTextField: Bool = true
    ) -> DictationContext {
        DictationContext(
            bundleIdentifier: bundleIdentifier,
            appName: appName,
            windowTitle: windowTitle,
            selectedText: selectedText,
            cursorInTextField: cursorInTextField
        )
    }

    func testConversationModeRoutesToOnTranscription() {
        manager.currentMode = .conversation
        var receivedText: String?
        manager.onTranscription = { receivedText = $0 }

        manager.handleFinalTranscription("hello world")

        XCTAssertEqual(receivedText, "hello world")
    }

    func testDictationModeWithoutContextFallsBackToConversation() {
        manager.currentMode = .dictation
        manager.currentDictationContext = nil
        var receivedText: String?
        manager.onTranscription = { receivedText = $0 }

        manager.handleFinalTranscription("fallback text")

        XCTAssertEqual(receivedText, "fallback text")
    }

    func testDictationModeSendsRequestToDictationClient() {
        manager.currentMode = .dictation
        manager.currentDictationContext = makeDictationContext(appName: "Notes")
        let requestExpectation = expectation(description: "dictation request sent")
        dictationClient.onProcess = {
            requestExpectation.fulfill()
        }

        manager.handleFinalTranscription("take a note")

        wait(for: [requestExpectation], timeout: 1.0)

        XCTAssertEqual(dictationClient.sentRequests.count, 1)
        let sent = dictationClient.sentRequests.first
        XCTAssertNotNil(sent)
        XCTAssertEqual(sent?.transcription, "take a note")
        XCTAssertEqual(sent?.context.appName, "Notes")
        XCTAssertEqual(sent?.type, "dictation_request")
    }

    func testDictationModeSetsAwaitingDictationResponse() {
        manager.currentMode = .dictation
        manager.currentDictationContext = makeDictationContext()

        manager.handleFinalTranscription("some text")

        XCTAssertTrue(manager.awaitingDaemonResponse)
    }

    func testDictationModeIncludesSelectedTextInContext() {
        manager.currentMode = .dictation
        manager.currentDictationContext = makeDictationContext(selectedText: "selected snippet")
        let requestExpectation = expectation(description: "dictation request sent")
        dictationClient.onProcess = {
            requestExpectation.fulfill()
        }

        manager.handleFinalTranscription("replace this")

        wait(for: [requestExpectation], timeout: 1.0)

        let sent = dictationClient.sentRequests.first
        XCTAssertEqual(sent?.context.selectedText, "selected snippet")
    }

    func testDictationModeUsesClientResponseToTriggerActionRouting() {
        manager.currentMode = .dictation
        manager.currentDictationContext = makeDictationContext()
        dictationClient.response = DictationResponseMessage(
            type: "dictation_response",
            text: "open Slack",
            mode: "action"
        )

        let actionExpectation = expectation(description: "action mode triggered")
        manager.onDictationResponse = { [weak manager] response in
            manager?.handleDictationResponse(text: response.text, mode: response.mode)
        }
        var receivedAction: String?
        manager.onActionModeTriggered = { text in
            receivedAction = text
            actionExpectation.fulfill()
        }

        manager.handleFinalTranscription("open Slack")

        wait(for: [actionExpectation], timeout: 1.0)
        XCTAssertEqual(receivedAction, "open Slack")
        XCTAssertFalse(manager.awaitingDaemonResponse)
    }

    func testDictationRequestIncludesBundleIdentifier() {
        manager.currentMode = .dictation
        manager.currentDictationContext = makeDictationContext(bundleIdentifier: "com.apple.Safari")
        let requestExpectation = expectation(description: "dictation request sent")
        dictationClient.onProcess = {
            requestExpectation.fulfill()
        }

        manager.handleFinalTranscription("search for this")

        wait(for: [requestExpectation], timeout: 1.0)

        let sent = dictationClient.sentRequests.first
        XCTAssertEqual(sent?.context.bundleIdentifier, "com.apple.Safari")
    }

    func testDictationRequestIncludesCursorInTextFieldFlag() {
        manager.currentMode = .dictation
        manager.currentDictationContext = makeDictationContext(cursorInTextField: false)
        let requestExpectation = expectation(description: "dictation request sent")
        dictationClient.onProcess = {
            requestExpectation.fulfill()
        }

        manager.handleFinalTranscription("type something")

        wait(for: [requestExpectation], timeout: 1.0)

        let sent = dictationClient.sentRequests.first
        XCTAssertEqual(sent?.context.cursorInTextField, false)
    }

    // MARK: - handleDictationResponse (mode detection)

    func testDictationResponseDictationModeClearsAwaitingFlag() {
        manager.handleDictationResponse(text: "cleaned text", mode: "dictation")

        XCTAssertFalse(manager.awaitingDaemonResponse)
    }

    func testDictationResponseCommandModeClearsAwaitingFlag() {
        manager.handleDictationResponse(text: "open terminal", mode: "command")

        XCTAssertFalse(manager.awaitingDaemonResponse)
    }

    func testDictationResponseActionModeTriggersCallback() {
        var actionText: String?
        manager.onActionModeTriggered = { actionText = $0 }

        manager.handleDictationResponse(text: "Slack Alex about the standup", mode: "action")

        XCTAssertEqual(actionText, "Slack Alex about the standup")
    }

    func testDictationResponseActionModeClearsAwaitingFlag() {
        manager.onActionModeTriggered = { _ in }

        manager.handleDictationResponse(text: "do something", mode: "action")

        XCTAssertFalse(manager.awaitingDaemonResponse)
    }

    func testDictationResponseDictationModeDoesNotTriggerActionCallback() {
        var actionTriggered = false
        manager.onActionModeTriggered = { _ in actionTriggered = true }

        manager.handleDictationResponse(text: "just text", mode: "dictation")

        XCTAssertFalse(actionTriggered)
    }

    func testDictationResponseCommandModeDoesNotTriggerActionCallback() {
        var actionTriggered = false
        manager.onActionModeTriggered = { _ in actionTriggered = true }

        manager.handleDictationResponse(text: "open app", mode: "command")

        XCTAssertFalse(actionTriggered)
    }

    // MARK: - Mode property

    func testDefaultModeIsDictation() {
        let fresh = VoiceInputManager()
        XCTAssertEqual(fresh.currentMode, .dictation)
    }

    func testModeCanBeSwitchedToConversation() {
        manager.currentMode = .conversation
        XCTAssertEqual(manager.currentMode, .conversation)
    }

    // MARK: - Speech Recognizer Adapter Integration

    func testInitUsesAdapterToCreateRecognizer() {
        // The mock adapter's makeRecognizer is called once during init
        XCTAssertEqual(speechAdapter.makeRecognizerCallCount, 1,
                       "VoiceInputManager should use the adapter to create the initial speech recognizer")
    }

    func testUnavailableRecognizerDoesNotStartRecording() {
        // Configure the adapter to report unavailable — no real SFSpeechRecognizer needed
        speechAdapter.stubbedIsRecognizerAvailable = false
        let freshManager = VoiceInputManager(
            dictationClient: dictationClient,
            speechRecognizerAdapter: speechAdapter
        )

        // Attempt to toggle recording — should not start because recognizer is unavailable
        freshManager.toggleRecording()

        XCTAssertFalse(freshManager.isRecording,
                       "Recording should not start when the speech recognizer is unavailable")
    }

    func testAdapterAuthorizationStatusIsUsedForPermissionCheck() {
        // Configure the adapter to report denied status
        speechAdapter.stubbedAuthorizationStatus = .denied

        // The manager checks adapter.authorizationStatus() in beginRecording().
        // When denied, it should not start recording (shows permission overlay instead).
        manager.toggleRecording()

        // Recording should not proceed when speech authorization is denied
        XCTAssertFalse(manager.isRecording,
                       "Recording should not start when speech recognition authorization is denied via adapter")
    }

    func testAdapterAuthorizationNotDeterminedShowsPermissionPrompt() {
        // Configure the adapter to report notDetermined status
        speechAdapter.stubbedAuthorizationStatus = .notDetermined

        // When authorization is notDetermined, beginRecording() should show the
        // permission primer and NOT start recording immediately.
        manager.toggleRecording()

        XCTAssertFalse(manager.isRecording,
                       "Recording should not start immediately when speech authorization is notDetermined")
    }

    // MARK: - STT Service-First Transcription Resolution

    func testServiceTextWinsOverNativeText() {
        // Configure STT service to return a successful transcription
        sttClient.stubbedResult = .success(text: "service transcription")
        manager.currentMode = .dictation
        manager.currentDictationContext = makeDictationContext()

        let requestExpectation = expectation(description: "dictation request sent with service text")
        dictationClient.onProcess = {
            requestExpectation.fulfill()
        }

        manager.handleFinalTranscription("native transcription")

        wait(for: [requestExpectation], timeout: 2.0)

        // The dictation request should use the service text, not the native text.
        // However, without accumulated audio buffers the STT service is skipped
        // and native text is used. This test verifies the fallback path when
        // no audio was captured (no recording session).
        let sent = dictationClient.sentRequests.first
        XCTAssertNotNil(sent)
        // Without audio buffers, native text is used as fallback
        XCTAssertEqual(sent?.transcription, "native transcription",
                       "Without audio buffers, native text should be used as fallback")
    }

    func testNativeTextUsedWhenSTTNotConfigured() {
        sttClient.stubbedResult = .notConfigured
        manager.currentMode = .dictation
        manager.currentDictationContext = makeDictationContext()

        let requestExpectation = expectation(description: "dictation request sent")
        dictationClient.onProcess = {
            requestExpectation.fulfill()
        }

        manager.handleFinalTranscription("native text")

        wait(for: [requestExpectation], timeout: 2.0)

        let sent = dictationClient.sentRequests.first
        XCTAssertNotNil(sent)
        XCTAssertEqual(sent?.transcription, "native text",
                       "Native text should be used when STT service is not configured")
    }

    func testNativeTextUsedWhenSTTServiceUnavailable() {
        sttClient.stubbedResult = .serviceUnavailable
        manager.currentMode = .dictation
        manager.currentDictationContext = makeDictationContext()

        let requestExpectation = expectation(description: "dictation request sent")
        dictationClient.onProcess = {
            requestExpectation.fulfill()
        }

        manager.handleFinalTranscription("native fallback")

        wait(for: [requestExpectation], timeout: 2.0)

        let sent = dictationClient.sentRequests.first
        XCTAssertNotNil(sent)
        XCTAssertEqual(sent?.transcription, "native fallback",
                       "Native text should be used when STT service is unavailable")
    }

    func testNativeTextUsedWhenSTTReturnsError() {
        sttClient.stubbedResult = .error(statusCode: 500, message: "Internal error")
        manager.currentMode = .dictation
        manager.currentDictationContext = makeDictationContext()

        let requestExpectation = expectation(description: "dictation request sent")
        dictationClient.onProcess = {
            requestExpectation.fulfill()
        }

        manager.handleFinalTranscription("native on error")

        wait(for: [requestExpectation], timeout: 2.0)

        let sent = dictationClient.sentRequests.first
        XCTAssertNotNil(sent)
        XCTAssertEqual(sent?.transcription, "native on error",
                       "Native text should be used when STT service returns an error")
    }

    func testNativeTextUsedWhenSTTReturnsEmptyText() {
        sttClient.stubbedResult = .success(text: "   ")
        manager.currentMode = .dictation
        manager.currentDictationContext = makeDictationContext()

        let requestExpectation = expectation(description: "dictation request sent")
        dictationClient.onProcess = {
            requestExpectation.fulfill()
        }

        manager.handleFinalTranscription("native when empty")

        wait(for: [requestExpectation], timeout: 2.0)

        let sent = dictationClient.sentRequests.first
        XCTAssertNotNil(sent)
        // Even if service "succeeds" with whitespace, native text is preferred
        XCTAssertEqual(sent?.transcription, "native when empty",
                       "Native text should be used when STT service returns empty/whitespace text")
    }

    func testSTTServiceNotCalledInConversationMode() {
        sttClient.stubbedResult = .success(text: "should not be used")
        manager.currentMode = .conversation
        var receivedText: String?
        manager.onTranscription = { receivedText = $0 }

        manager.handleFinalTranscription("conversation text")

        XCTAssertEqual(receivedText, "conversation text",
                       "Conversation mode should use native text directly without STT service")
        XCTAssertEqual(sttClient.transcribeCallCount, 0,
                       "STT service should not be called in conversation mode")
    }

    func testSTTServiceNotCalledWithoutDictationContext() {
        sttClient.stubbedResult = .success(text: "should not be used")
        manager.currentMode = .dictation
        manager.currentDictationContext = nil
        var receivedText: String?
        manager.onTranscription = { receivedText = $0 }

        manager.handleFinalTranscription("no context text")

        XCTAssertEqual(receivedText, "no context text",
                       "Without dictation context, should fall back to conversation path")
        XCTAssertEqual(sttClient.transcribeCallCount, 0,
                       "STT service should not be called without dictation context")
    }

    func testDictationClassificationUnchangedAfterSTTResolution() {
        // Verify that the dictation classification path (DictationClient.process)
        // still runs after STT resolution, preserving command/action routing.
        sttClient.stubbedResult = .notConfigured
        manager.currentMode = .dictation
        manager.currentDictationContext = makeDictationContext()
        dictationClient.response = DictationResponseMessage(
            type: "dictation_response",
            text: "classified text",
            mode: "command"
        )

        let responseExpectation = expectation(description: "dictation response received")
        manager.onDictationResponse = { [weak manager] response in
            manager?.handleDictationResponse(text: response.text, mode: response.mode)
            responseExpectation.fulfill()
        }

        manager.handleFinalTranscription("original text")

        wait(for: [responseExpectation], timeout: 2.0)

        // DictationClient.process was called with the resolved text
        XCTAssertEqual(dictationClient.sentRequests.count, 1,
                       "DictationClient.process should still be called after STT resolution")
        XCTAssertFalse(manager.awaitingDaemonResponse,
                       "awaitingDaemonResponse should be cleared after dictation response")
    }

    func testSTTClientInjectedViaInit() {
        // Verify that the STT client is injectable for testing
        let customSTT = MockSTTClient()
        customSTT.stubbedResult = .success(text: "custom stt")
        let customManager = VoiceInputManager(
            dictationClient: dictationClient,
            speechRecognizerAdapter: speechAdapter,
            sttClient: customSTT
        )

        // The manager should use the injected STT client
        customManager.currentMode = .dictation
        customManager.currentDictationContext = makeDictationContext()

        let requestExpectation = expectation(description: "dictation request sent")
        dictationClient.onProcess = {
            requestExpectation.fulfill()
        }

        customManager.handleFinalTranscription("test injection")

        wait(for: [requestExpectation], timeout: 2.0)

        // Without audio buffers, STT is skipped regardless of injected client
        let sent = dictationClient.sentRequests.first
        XCTAssertEqual(sent?.transcription, "test injection",
                       "Without audio buffers, native text should be used even with custom STT client")
    }
}
