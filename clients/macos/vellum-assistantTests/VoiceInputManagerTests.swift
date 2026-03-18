import XCTest
import VellumAssistantShared
@testable import VellumAssistantLib

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

@MainActor
final class VoiceInputManagerTests: XCTestCase {

    private var manager: VoiceInputManager!
    private var dictationClient: MockDictationClient!

    override func setUp() {
        super.setUp()
        dictationClient = MockDictationClient()
        manager = VoiceInputManager(dictationClient: dictationClient)
    }

    override func tearDown() {
        manager = nil
        dictationClient = nil
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
}
