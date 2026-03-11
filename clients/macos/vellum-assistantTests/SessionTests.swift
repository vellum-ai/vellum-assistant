import XCTest
import CoreGraphics
import Combine
@testable import VellumAssistantLib
@testable import VellumAssistantShared

// MARK: - Mock Daemon Client

/// A mock DaemonClientProtocol that lets tests inject messages into the stream
/// and inspect sent messages.
@MainActor
final class MockDaemonClient: DaemonClientProtocol {
    var sentMessages: [Any] = []
    var isConnected: Bool = true
    private var testContinuation: AsyncStream<ServerMessage>.Continuation?
    private var _messages: AsyncStream<ServerMessage>

    init() {
        let (stream, _) = AsyncStream<ServerMessage>.makeStream()
        self._messages = stream
    }

    /// Set up a controllable message stream for tests.
    /// Returns the continuation so tests can yield messages.
    func setupTestStream() -> AsyncStream<ServerMessage>.Continuation {
        let (stream, continuation) = AsyncStream<ServerMessage>.makeStream()
        self._messages = stream
        self.testContinuation = continuation
        return continuation
    }

    func subscribe() -> AsyncStream<ServerMessage> {
        _messages
    }

    func send<T: Encodable>(_ message: T) throws {
        sentMessages.append(message)
    }

    func connect() async throws {
        isConnected = true
    }

    func disconnect() {
        isConnected = false
    }

    func startSSE() {}
    func stopSSE() {}
}

// MARK: - Mocks

final class MockAccessibilityTreeEnumerator: AccessibilityTreeProviding {
    var result: (elements: [AXElement], windowTitle: String, appName: String, pid: pid_t)?
    var secondaryWindowCallCount = 0

    init(result: (elements: [AXElement], windowTitle: String, appName: String)? = nil) {
        if let r = result {
            self.result = (elements: r.elements, windowTitle: r.windowTitle, appName: r.appName, pid: 12345)
        } else {
            self.result = nil
        }
    }

    func enumerateCurrentWindow() -> (elements: [AXElement], windowTitle: String, appName: String, pid: pid_t)? {
        return result
    }

    func enumerateSecondaryWindows(excludingPID: pid_t?, maxWindows: Int) -> [WindowInfo] {
        secondaryWindowCallCount += 1
        return []
    }
}

final class MockScreenCapture: ScreenCaptureProviding, @unchecked Sendable {
    var captureCallCount = 0

    func captureScreen(maxWidth: Int, maxHeight: Int) async throws -> Data {
        captureCallCount += 1
        return Data([0xFF, 0xD8, 0xFF]) // Minimal JPEG-like stub
    }

    func captureScreenWithMetadata(maxWidth: Int, maxHeight: Int) async throws -> ScreenCaptureResult {
        captureCallCount += 1
        return ScreenCaptureResult(
            jpegData: Data([0xFF, 0xD8, 0xFF]),
            metadata: ScreenCaptureMetadata(
                screenshotWidthPx: 1280,
                screenshotHeightPx: 720,
                captureDisplayId: 77
            )
        )
    }

    func screenSize() -> CGSize {
        return CGSize(width: 1920, height: 1080)
    }
}

final class MockActionExecutor: ActionExecuting {
    var executedActions: [AgentAction] = []
    var shouldFailOnCall: Int? = nil
    var mockResult: String? = nil
    var shouldThrowAppleScriptError: Bool = false
    private var callCount = 0

    func execute(_ action: AgentAction) async throws -> String? {
        if shouldFailOnCall == callCount {
            callCount += 1
            throw ExecutorError.eventCreationFailed
        }
        if shouldThrowAppleScriptError && action.type == .runAppleScript {
            callCount += 1
            executedActions.append(action)
            throw ExecutorError.appleScriptError("Mock AppleScript error")
        }
        callCount += 1
        executedActions.append(action)
        if action.type == .runAppleScript {
            return mockResult
        }
        return nil
    }
}

// MARK: - Test Helpers

private func makeTestElements() -> [AXElement] {
    [
        AXElement(
            id: 1,
            role: "AXButton",
            title: "Submit",
            value: nil,
            frame: CGRect(x: 100, y: 200, width: 80, height: 30),
            isEnabled: true,
            isFocused: false,
            children: [],
            roleDescription: "button",
            identifier: nil,
            url: nil,
            placeholderValue: nil
        ),
        AXElement(
            id: 2,
            role: "AXTextField",
            title: nil,
            value: "",
            frame: CGRect(x: 100, y: 150, width: 200, height: 30),
            isEnabled: true,
            isFocused: true,
            children: [],
            roleDescription: "text field",
            identifier: nil,
            url: nil,
            placeholderValue: "Enter name"
        ),
        AXElement(
            id: 3,
            role: "AXStaticText",
            title: "Welcome",
            value: nil,
            frame: CGRect(x: 100, y: 100, width: 200, height: 20),
            isEnabled: true,
            isFocused: false,
            children: [],
            roleDescription: "text",
            identifier: nil,
            url: nil,
            placeholderValue: nil
        )
    ]
}

private func makeDefaultEnumerator() -> MockAccessibilityTreeEnumerator {
    MockAccessibilityTreeEnumerator(
        result: (elements: makeTestElements(), windowTitle: "Test Window", appName: "TestApp")
    )
}

@MainActor private func makeSession(
    task: String = "test task",
    daemonClient: MockDaemonClient,
    enumerator: AccessibilityTreeProviding? = nil,
    screenCapture: MockScreenCapture? = nil,
    executor: MockActionExecutor? = nil,
    maxSteps: Int = 50
) -> ComputerUseSession {
    ComputerUseSession(
        task: task,
        daemonClient: daemonClient,
        enumerator: enumerator ?? makeDefaultEnumerator(),
        screenCapture: screenCapture ?? MockScreenCapture(),
        executor: executor ?? MockActionExecutor(),
        maxSteps: maxSteps,
        initialDelayMs: 0,
        adaptiveDelay: false
    )
}

/// Helper to create a CuActionMessage for tests
private func makeActionMessage(
    sessionId: String,
    toolName: String,
    input: [String: AnyCodable] = [:],
    reasoning: String? = nil,
    stepNumber: Int = 1
) -> CuActionMessage {
    CuActionMessage(
        sessionId: sessionId,
        toolName: toolName,
        input: input,
        reasoning: reasoning,
        stepNumber: stepNumber
    )
}

/// Helper to create a CuCompleteMessage for tests
private func makeCompleteMessage(
    sessionId: String,
    summary: String = "Task completed",
    stepCount: Int = 1
) -> CuCompleteMessage {
    CuCompleteMessage(
        sessionId: sessionId,
        summary: summary,
        stepCount: stepCount,
        isResponse: nil
    )
}

/// Helper to create a CuErrorMessage for tests
private func makeErrorMessage(
    sessionId: String,
    message: String = "Something went wrong"
) -> CuErrorMessage {
    CuErrorMessage(
        sessionId: sessionId,
        message: message
    )
}

// MARK: - Tests

final class SessionTests: XCTestCase {

    // MARK: - Happy Path

    @MainActor
    func testHappyPath_completesInThreeSteps() async {
        let daemonClient = MockDaemonClient()
        let continuation = daemonClient.setupTestStream()
        let executor = MockActionExecutor()
        let session = makeSession(daemonClient: daemonClient, executor: executor)

        let runTask = Task { @MainActor in
            await session.run()
        }

        // Wait for session to start and send initial observation
        try? await Task.sleep(nanoseconds: 50_000_000)

        // Step 1: click
        continuation.yield(.cuAction(makeActionMessage(
            sessionId: session.id,
            toolName: "cu_click",
            input: ["x": AnyCodable(140), "y": AnyCodable(215)],
            reasoning: "Click submit",
            stepNumber: 1
        )))
        try? await Task.sleep(nanoseconds: 50_000_000)

        // Step 2: type
        continuation.yield(.cuAction(makeActionMessage(
            sessionId: session.id,
            toolName: "cu_type_text",
            input: ["text": AnyCodable("John")],
            reasoning: "Type name",
            stepNumber: 2
        )))
        try? await Task.sleep(nanoseconds: 50_000_000)

        // Step 3: done + complete
        continuation.yield(.cuAction(makeActionMessage(
            sessionId: session.id,
            toolName: "cu_done",
            input: ["summary": AnyCodable("Filled form and submitted")],
            reasoning: "Task complete",
            stepNumber: 3
        )))
        try? await Task.sleep(nanoseconds: 20_000_000)

        continuation.yield(.cuComplete(makeCompleteMessage(
            sessionId: session.id,
            summary: "Filled form and submitted",
            stepCount: 3
        )))

        await runTask.value

        if case .completed(let summary, let steps) = session.state {
            XCTAssertEqual(steps, 3)
            XCTAssertEqual(summary, "Filled form and submitted")
        } else {
            XCTFail("Expected completed state, got \(session.state)")
        }

        // Verify executor received the non-done actions
        XCTAssertEqual(executor.executedActions.count, 2)
        XCTAssertEqual(executor.executedActions[0].type, .click)
        XCTAssertEqual(executor.executedActions[1].type, .type)
    }

    @MainActor
    func testSingleStepDone_completesImmediately() async {
        let daemonClient = MockDaemonClient()
        let continuation = daemonClient.setupTestStream()
        let session = makeSession(daemonClient: daemonClient)

        let runTask = Task { @MainActor in
            await session.run()
        }

        try? await Task.sleep(nanoseconds: 50_000_000)

        continuation.yield(.cuAction(makeActionMessage(
            sessionId: session.id,
            toolName: "cu_done",
            input: ["summary": AnyCodable("Nothing to do")],
            reasoning: "Already done",
            stepNumber: 1
        )))
        try? await Task.sleep(nanoseconds: 20_000_000)

        continuation.yield(.cuComplete(makeCompleteMessage(
            sessionId: session.id,
            summary: "Nothing to do",
            stepCount: 1
        )))

        await runTask.value

        if case .completed(let summary, let steps) = session.state {
            XCTAssertEqual(steps, 1)
            XCTAssertEqual(summary, "Nothing to do")
        } else {
            XCTFail("Expected completed state, got \(session.state)")
        }
    }

    // MARK: - Cancellation

    @MainActor
    func testCancellation_stopsSession() async {
        let daemonClient = MockDaemonClient()
        let continuation = daemonClient.setupTestStream()
        let session = makeSession(daemonClient: daemonClient)

        let runTask = Task { @MainActor in
            await session.run()
        }

        // Wait for session to start
        try? await Task.sleep(nanoseconds: 50_000_000)

        // Send one action
        continuation.yield(.cuAction(makeActionMessage(
            sessionId: session.id,
            toolName: "cu_click",
            input: ["x": AnyCodable(100), "y": AnyCodable(200)],
            reasoning: "click",
            stepNumber: 1
        )))
        try? await Task.sleep(nanoseconds: 50_000_000)

        session.cancel()
        continuation.finish() // End the stream so for-await exits

        await runTask.value

        XCTAssertEqual(session.state, .cancelled)
    }

    // MARK: - Daemon Error

    @MainActor
    func testDaemonError_failsSession() async {
        let daemonClient = MockDaemonClient()
        let continuation = daemonClient.setupTestStream()
        let session = makeSession(daemonClient: daemonClient)

        let runTask = Task { @MainActor in
            await session.run()
        }

        try? await Task.sleep(nanoseconds: 50_000_000)

        continuation.yield(.cuError(makeErrorMessage(
            sessionId: session.id,
            message: "Inference failed: Mock network error"
        )))

        await runTask.value

        if case .failed(let reason) = session.state {
            XCTAssertTrue(reason.contains("Inference failed"), "Expected inference failure, got: \(reason)")
        } else {
            XCTFail("Expected failed state, got \(session.state)")
        }
    }

    // MARK: - Execution Failure

    @MainActor
    func testExecutionFailure_sendsErrorObservation() async {
        let daemonClient = MockDaemonClient()
        let continuation = daemonClient.setupTestStream()
        let executor = MockActionExecutor()
        executor.shouldFailOnCall = 0
        let session = makeSession(daemonClient: daemonClient, executor: executor)

        let runTask = Task { @MainActor in
            await session.run()
        }

        try? await Task.sleep(nanoseconds: 50_000_000)

        // Send action that will fail execution
        continuation.yield(.cuAction(makeActionMessage(
            sessionId: session.id,
            toolName: "cu_click",
            input: ["x": AnyCodable(100), "y": AnyCodable(200)],
            reasoning: "click",
            stepNumber: 1
        )))
        try? await Task.sleep(nanoseconds: 50_000_000)

        // Daemon sends error after observing the execution error
        continuation.yield(.cuError(makeErrorMessage(
            sessionId: session.id,
            message: "Execution failed"
        )))

        await runTask.value

        if case .failed(let reason) = session.state {
            XCTAssertTrue(reason.contains("Execution failed"))
        } else {
            XCTFail("Expected failed state, got \(session.state)")
        }
    }

    // MARK: - Confirmation Flow

    @MainActor
    func testConfirmation_approved_continuesSession() async {
        let daemonClient = MockDaemonClient()
        let continuation = daemonClient.setupTestStream()
        let session = makeSession(daemonClient: daemonClient)

        let runTask = Task { @MainActor in
            await session.run()
        }

        try? await Task.sleep(nanoseconds: 50_000_000)

        // Send a dangerous key action that requires confirmation
        continuation.yield(.cuAction(makeActionMessage(
            sessionId: session.id,
            toolName: "cu_key",
            input: ["key": AnyCodable("cmd+q")],
            reasoning: "quit app",
            stepNumber: 1
        )))

        // Wait for confirmation state
        var sawConfirmation = false
        for _ in 0..<200 {
            if case .awaitingConfirmation = session.state {
                sawConfirmation = true
                break
            }
            try? await Task.sleep(nanoseconds: 10_000_000) // 10ms
        }

        XCTAssertTrue(sawConfirmation, "Should have reached awaitingConfirmation state")

        session.approveConfirmation()
        try? await Task.sleep(nanoseconds: 50_000_000)

        // Daemon sends complete
        continuation.yield(.cuComplete(makeCompleteMessage(
            sessionId: session.id,
            summary: "Completed after approval",
            stepCount: 1
        )))

        await runTask.value

        if case .completed(let summary, _) = session.state {
            XCTAssertEqual(summary, "Completed after approval")
        } else {
            XCTFail("Expected completed state after approval, got \(session.state)")
        }
    }

    @MainActor
    func testConfirmation_rejected_cancelsSession() async {
        let daemonClient = MockDaemonClient()
        let continuation = daemonClient.setupTestStream()
        let session = makeSession(daemonClient: daemonClient)

        let runTask = Task { @MainActor in
            await session.run()
        }

        try? await Task.sleep(nanoseconds: 50_000_000)

        continuation.yield(.cuAction(makeActionMessage(
            sessionId: session.id,
            toolName: "cu_key",
            input: ["key": AnyCodable("cmd+q")],
            reasoning: "quit app",
            stepNumber: 1
        )))

        // Wait for confirmation state
        for _ in 0..<200 {
            if case .awaitingConfirmation = session.state { break }
            try? await Task.sleep(nanoseconds: 10_000_000)
        }

        session.rejectConfirmation()
        continuation.finish()

        await runTask.value

        XCTAssertEqual(session.state, .cancelled)
    }

    // MARK: - Task Property

    @MainActor
    func testTaskProperty_matchesInput() async {
        let daemonClient = MockDaemonClient()
        _ = daemonClient.setupTestStream()
        let session = makeSession(task: "Open Safari and search for cats", daemonClient: daemonClient)

        XCTAssertEqual(session.task, "Open Safari and search for cats")
    }

    // MARK: - Message Filtering

    @MainActor
    func testMessagesForOtherSession_ignored() async {
        let daemonClient = MockDaemonClient()
        let continuation = daemonClient.setupTestStream()
        let session = makeSession(daemonClient: daemonClient)

        let runTask = Task { @MainActor in
            await session.run()
        }

        try? await Task.sleep(nanoseconds: 50_000_000)

        // Send messages for a different session — should be ignored
        continuation.yield(.cuComplete(makeCompleteMessage(
            sessionId: "other-session-id",
            summary: "Other session done",
            stepCount: 5
        )))

        try? await Task.sleep(nanoseconds: 30_000_000)

        // Session should still be running/thinking, not completed
        if case .completed = session.state {
            XCTFail("Should not have completed from another session's message")
        }

        // Now complete this session
        continuation.yield(.cuComplete(makeCompleteMessage(
            sessionId: session.id,
            summary: "This session done",
            stepCount: 1
        )))

        await runTask.value

        if case .completed(let summary, _) = session.state {
            XCTAssertEqual(summary, "This session done")
        } else {
            XCTFail("Expected completed state, got \(session.state)")
        }
    }

    // MARK: - Message Sending

    @MainActor
    func testSessionCreate_sentOnStart() async {
        let daemonClient = MockDaemonClient()
        let continuation = daemonClient.setupTestStream()
        let session = makeSession(task: "click the button", daemonClient: daemonClient)

        let runTask = Task { @MainActor in
            await session.run()
        }

        try? await Task.sleep(nanoseconds: 50_000_000)

        // Check that a CuSessionCreateMessage was sent
        let createMessages = daemonClient.sentMessages.compactMap { $0 as? CuSessionCreateMessage }
        XCTAssertEqual(createMessages.count, 1)
        XCTAssertEqual(createMessages[0].sessionId, session.id)
        XCTAssertEqual(createMessages[0].task, "click the button")
        XCTAssertEqual(createMessages[0].screenWidth, 1920)
        XCTAssertEqual(createMessages[0].screenHeight, 1080)

        // Check that an observation was sent
        let obsMessages = daemonClient.sentMessages.compactMap { $0 as? CuObservationMessage }
        XCTAssertGreaterThanOrEqual(obsMessages.count, 1)
        XCTAssertEqual(obsMessages[0].sessionId, session.id)

        // Clean up
        session.cancel()
        continuation.finish()
        await runTask.value
    }

    @MainActor
    func testObservationIncludesScreenshotMetadata_whenScreenshotPresent() async {
        let daemonClient = MockDaemonClient()
        let continuation = daemonClient.setupTestStream()
        let session = makeSession(task: "capture metadata", daemonClient: daemonClient)

        let runTask = Task { @MainActor in
            await session.run()
        }

        try? await Task.sleep(nanoseconds: 50_000_000)

        let obsMessages = daemonClient.sentMessages.compactMap { $0 as? CuObservationMessage }
        XCTAssertGreaterThanOrEqual(obsMessages.count, 1)
        let firstObservation = obsMessages[0]

        XCTAssertEqual(firstObservation.screenshotWidthPx, 1280.0)
        XCTAssertEqual(firstObservation.screenshotHeightPx, 720.0)
        XCTAssertEqual(firstObservation.screenWidthPt, 1920.0)
        XCTAssertEqual(firstObservation.screenHeightPt, 1080.0)
        XCTAssertEqual(firstObservation.coordinateOrigin, "top_left")
        XCTAssertEqual(firstObservation.captureDisplayId, 77.0)

        session.cancel()
        continuation.finish()
        await runTask.value
    }

    func testCuObservationDecoding_backwardCompatibleWithoutMetadata() throws {
        let legacyJSON = """
        {
          "type": "cu_observation",
          "sessionId": "cu-sess-legacy",
          "axTree": "<ax-tree>...</ax-tree>",
          "screenshot": "base64-screenshot-data"
        }
        """
        let data = try XCTUnwrap(legacyJSON.data(using: .utf8))
        let decoded = try JSONDecoder().decode(CuObservationMessage.self, from: data)

        XCTAssertEqual(decoded.type, "cu_observation")
        XCTAssertEqual(decoded.sessionId, "cu-sess-legacy")
        XCTAssertNil(decoded.screenshotWidthPx)
        XCTAssertNil(decoded.screenshotHeightPx)
        XCTAssertNil(decoded.screenWidthPt)
        XCTAssertNil(decoded.screenHeightPt)
        XCTAssertNil(decoded.coordinateOrigin)
        XCTAssertNil(decoded.captureDisplayId)
    }

    @MainActor
    func testObservation_sentAfterAction() async {
        let daemonClient = MockDaemonClient()
        let continuation = daemonClient.setupTestStream()
        let session = makeSession(daemonClient: daemonClient)

        let runTask = Task { @MainActor in
            await session.run()
        }

        try? await Task.sleep(nanoseconds: 50_000_000)

        let initialObsCount = daemonClient.sentMessages.compactMap({ $0 as? CuObservationMessage }).count

        // Send an action
        continuation.yield(.cuAction(makeActionMessage(
            sessionId: session.id,
            toolName: "cu_click",
            input: ["x": AnyCodable(100), "y": AnyCodable(200)],
            reasoning: "click button",
            stepNumber: 1
        )))
        try? await Task.sleep(nanoseconds: 50_000_000)

        // Should have sent another observation after executing
        let obsMessages = daemonClient.sentMessages.compactMap { $0 as? CuObservationMessage }
        XCTAssertGreaterThan(obsMessages.count, initialObsCount, "Should send observation after action execution")

        session.cancel()
        continuation.finish()
        await runTask.value
    }

    // MARK: - Element ID Resolution

    @MainActor
    func testClickWithElementId_resolvesCoordinates() async {
        let daemonClient = MockDaemonClient()
        let continuation = daemonClient.setupTestStream()
        let executor = MockActionExecutor()
        let session = makeSession(daemonClient: daemonClient, executor: executor)

        let runTask = Task { @MainActor in
            await session.run()
        }

        try? await Task.sleep(nanoseconds: 50_000_000)

        continuation.yield(.cuAction(makeActionMessage(
            sessionId: session.id,
            toolName: "cu_click",
            input: ["element_id": AnyCodable(1)],
            reasoning: "Click the submit button by ID",
            stepNumber: 1
        )))
        try? await Task.sleep(nanoseconds: 50_000_000)

        continuation.yield(.cuComplete(makeCompleteMessage(
            sessionId: session.id,
            summary: "Clicked by ID",
            stepCount: 1
        )))

        await runTask.value

        XCTAssertEqual(executor.executedActions.count, 1)
        let executed = executor.executedActions[0]
        XCTAssertEqual(executed.type, .click)
        XCTAssertEqual(executed.resolvedFromElementId, 1)
        XCTAssertEqual(executed.x ?? -1, 140, accuracy: 0.001)
        XCTAssertEqual(executed.y ?? -1, 215, accuracy: 0.001)
    }

    @MainActor
    func testDragWithElementIds_resolvesBothEndpoints() async {
        let daemonClient = MockDaemonClient()
        let continuation = daemonClient.setupTestStream()
        let executor = MockActionExecutor()
        let session = makeSession(daemonClient: daemonClient, executor: executor)

        let runTask = Task { @MainActor in
            await session.run()
        }

        try? await Task.sleep(nanoseconds: 50_000_000)

        continuation.yield(.cuAction(makeActionMessage(
            sessionId: session.id,
            toolName: "cu_drag",
            input: [
                "element_id": AnyCodable(1),
                "to_element_id": AnyCodable(2),
            ],
            reasoning: "Drag from source ID to destination ID",
            stepNumber: 1
        )))
        try? await Task.sleep(nanoseconds: 50_000_000)

        continuation.yield(.cuComplete(makeCompleteMessage(
            sessionId: session.id,
            summary: "Dragged by IDs",
            stepCount: 1
        )))

        await runTask.value

        XCTAssertEqual(executor.executedActions.count, 1)
        let executed = executor.executedActions[0]
        XCTAssertEqual(executed.type, .drag)
        XCTAssertEqual(executed.resolvedFromElementId, 1)
        XCTAssertEqual(executed.resolvedToElementId, 2)
        XCTAssertEqual(executed.x ?? -1, 140, accuracy: 0.001)
        XCTAssertEqual(executed.y ?? -1, 215, accuracy: 0.001)
        XCTAssertEqual(executed.toX ?? -1, 200, accuracy: 0.001)
        XCTAssertEqual(executed.toY ?? -1, 165, accuracy: 0.001)
    }

    @MainActor
    func testUnresolvableElementId_sendsRecoverableErrorObservation() async {
        let daemonClient = MockDaemonClient()
        let continuation = daemonClient.setupTestStream()
        let executor = MockActionExecutor()
        let session = makeSession(daemonClient: daemonClient, executor: executor)

        let runTask = Task { @MainActor in
            await session.run()
        }

        try? await Task.sleep(nanoseconds: 50_000_000)

        let initialObsCount = daemonClient.sentMessages.compactMap({ $0 as? CuObservationMessage }).count

        continuation.yield(.cuAction(makeActionMessage(
            sessionId: session.id,
            toolName: "cu_click",
            input: ["element_id": AnyCodable(999)],
            reasoning: "Try stale element ID",
            stepNumber: 1
        )))
        try? await Task.sleep(nanoseconds: 50_000_000)

        let obsMessages = daemonClient.sentMessages.compactMap { $0 as? CuObservationMessage }
        XCTAssertGreaterThan(obsMessages.count, initialObsCount)
        XCTAssertTrue(obsMessages.last?.executionError?.contains("Could not resolve element_id [999]") == true)
        XCTAssertEqual(executor.executedActions.count, 0)

        continuation.yield(.cuComplete(makeCompleteMessage(
            sessionId: session.id,
            summary: "Recovered from stale id",
            stepCount: 1
        )))
        await runTask.value
    }

    @MainActor
    func testDragDestinationElementId_acceptsCamelCaseKey() async {
        let daemonClient = MockDaemonClient()
        let continuation = daemonClient.setupTestStream()
        let executor = MockActionExecutor()
        let session = makeSession(daemonClient: daemonClient, executor: executor)

        let runTask = Task { @MainActor in
            await session.run()
        }

        try? await Task.sleep(nanoseconds: 50_000_000)

        continuation.yield(.cuAction(makeActionMessage(
            sessionId: session.id,
            toolName: "cu_drag",
            input: [
                "element_id": AnyCodable(1),
                "toElementId": AnyCodable(2),
            ],
            reasoning: "Use camelCase destination element key",
            stepNumber: 1
        )))
        try? await Task.sleep(nanoseconds: 50_000_000)

        continuation.yield(.cuComplete(makeCompleteMessage(
            sessionId: session.id,
            summary: "Dragged by camelCase IDs",
            stepCount: 1
        )))

        await runTask.value

        XCTAssertEqual(executor.executedActions.count, 1)
        XCTAssertEqual(executor.executedActions[0].resolvedToElementId, 2)
        XCTAssertEqual(executor.executedActions[0].toX ?? -1, 200, accuracy: 0.001)
        XCTAssertEqual(executor.executedActions[0].toY ?? -1, 165, accuracy: 0.001)
    }

    @MainActor
    func testStaleElementId_resetsBlockStreak() async {
        let daemonClient = MockDaemonClient()
        let continuation = daemonClient.setupTestStream()
        let executor = MockActionExecutor()
        let session = makeSession(daemonClient: daemonClient, executor: executor)

        let runTask = Task { @MainActor in
            await session.run()
        }

        try? await Task.sleep(nanoseconds: 50_000_000)

        // Block 1: AppleScript with "do shell script" → blocked
        continuation.yield(.cuAction(makeActionMessage(
            sessionId: session.id,
            toolName: "cu_run_applescript",
            input: ["script": AnyCodable("do shell script \"echo hi\"")],
            reasoning: "bad 1",
            stepNumber: 1
        )))
        try? await Task.sleep(nanoseconds: 50_000_000)

        // Block 2: same blocked pattern
        continuation.yield(.cuAction(makeActionMessage(
            sessionId: session.id,
            toolName: "cu_run_applescript",
            input: ["script": AnyCodable("do shell script \"echo hi\"")],
            reasoning: "bad 2",
            stepNumber: 2
        )))
        try? await Task.sleep(nanoseconds: 50_000_000)

        // Stale element_id resolution failure — should reset block streak
        continuation.yield(.cuAction(makeActionMessage(
            sessionId: session.id,
            toolName: "cu_click",
            input: ["element_id": AnyCodable(999)],
            reasoning: "stale id",
            stepNumber: 3
        )))
        try? await Task.sleep(nanoseconds: 50_000_000)

        // Block 3: would be the 3rd consecutive block without the reset
        continuation.yield(.cuAction(makeActionMessage(
            sessionId: session.id,
            toolName: "cu_run_applescript",
            input: ["script": AnyCodable("do shell script \"echo hi\"")],
            reasoning: "bad 3",
            stepNumber: 4
        )))
        try? await Task.sleep(nanoseconds: 50_000_000)

        // Session should NOT have failed — the stale-id turn broke the streak
        if case .failed(let reason) = session.state {
            XCTFail("Session should not have failed; stale element_id should reset block streak. Got: \(reason)")
        }

        // Complete the session normally
        continuation.yield(.cuComplete(makeCompleteMessage(
            sessionId: session.id,
            summary: "Survived block streak reset",
            stepCount: 4
        )))

        await runTask.value

        if case .completed(let summary, _) = session.state {
            XCTAssertEqual(summary, "Survived block streak reset")
        } else {
            XCTFail("Expected completed state, got \(session.state)")
        }
    }

    // MARK: - Undo

    @MainActor
    func testUndo_incrementsCount() async {
        let daemonClient = MockDaemonClient()
        _ = daemonClient.setupTestStream()
        let executor = MockActionExecutor()
        let session = makeSession(daemonClient: daemonClient, executor: executor)

        XCTAssertEqual(session.undoCount, 0)
        session.undo()
        try? await Task.sleep(nanoseconds: 10_000_000) // let async undo complete
        XCTAssertEqual(session.undoCount, 1)
        session.undo()
        try? await Task.sleep(nanoseconds: 10_000_000)
        XCTAssertEqual(session.undoCount, 2)

        // Verify undo went through the injected executor
        XCTAssertEqual(executor.executedActions.count, 2)
        XCTAssertEqual(executor.executedActions[0].type, .key)
        XCTAssertEqual(executor.executedActions[0].key, "cmd+z")
    }

    @MainActor
    func testUndo_worksAfterCompletion() async {
        let daemonClient = MockDaemonClient()
        let continuation = daemonClient.setupTestStream()
        let executor = MockActionExecutor()
        let session = makeSession(daemonClient: daemonClient, executor: executor)

        let runTask = Task { @MainActor in
            await session.run()
        }

        try? await Task.sleep(nanoseconds: 50_000_000)

        continuation.yield(.cuComplete(makeCompleteMessage(
            sessionId: session.id,
            summary: "Done",
            stepCount: 1
        )))

        await runTask.value

        if case .completed = session.state {
            // Good — session completed
        } else {
            XCTFail("Expected completed state, got \(session.state)")
        }

        // Undo should work even after session is completed
        session.undo()
        try? await Task.sleep(nanoseconds: 10_000_000)
        XCTAssertEqual(session.undoCount, 1)
        session.undo()
        try? await Task.sleep(nanoseconds: 10_000_000)
        XCTAssertEqual(session.undoCount, 2)

        let undoActions = executor.executedActions.filter { $0.type == .key && $0.key == "cmd+z" }
        XCTAssertEqual(undoActions.count, 2)
    }

    // MARK: - Open App

    @MainActor
    func testOpenApp_executesSuccessfully() async {
        let daemonClient = MockDaemonClient()
        let continuation = daemonClient.setupTestStream()
        let executor = MockActionExecutor()
        let session = makeSession(daemonClient: daemonClient, executor: executor)

        let runTask = Task { @MainActor in
            await session.run()
        }

        try? await Task.sleep(nanoseconds: 50_000_000)

        continuation.yield(.cuAction(makeActionMessage(
            sessionId: session.id,
            toolName: "cu_open_app",
            input: ["app_name": AnyCodable("Slack")],
            reasoning: "Open Slack to send message",
            stepNumber: 1
        )))
        try? await Task.sleep(nanoseconds: 50_000_000)

        continuation.yield(.cuComplete(makeCompleteMessage(
            sessionId: session.id,
            summary: "Opened Slack",
            stepCount: 2
        )))

        await runTask.value

        if case .completed(let summary, let steps) = session.state {
            XCTAssertEqual(steps, 2)
            XCTAssertEqual(summary, "Opened Slack")
        } else {
            XCTFail("Expected completed state, got \(session.state)")
        }

        XCTAssertEqual(executor.executedActions.count, 1)
        XCTAssertEqual(executor.executedActions[0].type, .openApp)
        XCTAssertEqual(executor.executedActions[0].appName, "Slack")
    }

    // MARK: - AppleScript

    @MainActor
    func testAppleScript_requiresConfirmation_approved() async {
        let daemonClient = MockDaemonClient()
        let continuation = daemonClient.setupTestStream()
        let executor = MockActionExecutor()
        executor.mockResult = "https://example.com"
        let session = makeSession(daemonClient: daemonClient, executor: executor)

        let runTask = Task { @MainActor in
            await session.run()
        }

        try? await Task.sleep(nanoseconds: 50_000_000)

        continuation.yield(.cuAction(makeActionMessage(
            sessionId: session.id,
            toolName: "cu_run_applescript",
            input: ["script": AnyCodable("tell application \"Safari\" to set URL of current tab of front window to \"https://example.com\"")],
            reasoning: "Set Safari URL",
            stepNumber: 1
        )))

        // Wait for confirmation state
        var sawConfirmation = false
        for _ in 0..<200 {
            if case .awaitingConfirmation = session.state {
                sawConfirmation = true
                break
            }
            try? await Task.sleep(nanoseconds: 10_000_000)
        }

        XCTAssertTrue(sawConfirmation, "AppleScript should require confirmation")
        session.approveConfirmation()
        try? await Task.sleep(nanoseconds: 50_000_000)

        continuation.yield(.cuComplete(makeCompleteMessage(
            sessionId: session.id,
            summary: "Set URL via AppleScript",
            stepCount: 1
        )))

        await runTask.value

        if case .completed(let summary, _) = session.state {
            XCTAssertEqual(summary, "Set URL via AppleScript")
        } else {
            XCTFail("Expected completed state, got \(session.state)")
        }
        XCTAssertEqual(executor.executedActions.count, 1)
        XCTAssertEqual(executor.executedActions[0].type, .runAppleScript)
    }

    @MainActor
    func testAppleScript_doShellScript_blocked() async {
        let daemonClient = MockDaemonClient()
        let continuation = daemonClient.setupTestStream()
        let executor = MockActionExecutor()
        let session = makeSession(daemonClient: daemonClient, executor: executor)

        let runTask = Task { @MainActor in
            await session.run()
        }

        try? await Task.sleep(nanoseconds: 50_000_000)

        // Send 3 blocked AppleScript actions to trigger the "too many blocks" failure
        for i in 1...3 {
            continuation.yield(.cuAction(makeActionMessage(
                sessionId: session.id,
                toolName: "cu_run_applescript",
                input: ["script": AnyCodable("do shell script \"rm -rf /\"")],
                reasoning: "bad \(i)",
                stepNumber: i
            )))
            try? await Task.sleep(nanoseconds: 50_000_000)
        }

        // The session should fail after 3 consecutive blocks
        // Give it a moment to process
        try? await Task.sleep(nanoseconds: 100_000_000)

        // End the stream to unblock for-await
        continuation.finish()
        await runTask.value

        if case .failed(let reason) = session.state {
            XCTAssertTrue(reason.contains("blocked"), "Expected block-related failure, got: \(reason)")
        } else {
            XCTFail("Expected failed state, got \(session.state)")
        }
        // None should have been executed
        XCTAssertEqual(executor.executedActions.count, 0)
    }

    @MainActor
    func testAppleScript_confirmationRejected_cancelsSession() async {
        let daemonClient = MockDaemonClient()
        let continuation = daemonClient.setupTestStream()
        let session = makeSession(daemonClient: daemonClient)

        let runTask = Task { @MainActor in
            await session.run()
        }

        try? await Task.sleep(nanoseconds: 50_000_000)

        continuation.yield(.cuAction(makeActionMessage(
            sessionId: session.id,
            toolName: "cu_run_applescript",
            input: ["script": AnyCodable("tell application \"Safari\" to return name of front window")],
            reasoning: "Set URL",
            stepNumber: 1
        )))

        for _ in 0..<200 {
            if case .awaitingConfirmation = session.state { break }
            try? await Task.sleep(nanoseconds: 10_000_000)
        }

        session.rejectConfirmation()
        continuation.finish()

        await runTask.value

        XCTAssertEqual(session.state, .cancelled)
    }

    // MARK: - AppleScript (execution error)

    @MainActor
    func testAppleScript_executionError_nonFatal() async {
        let daemonClient = MockDaemonClient()
        let continuation = daemonClient.setupTestStream()
        let executor = MockActionExecutor()
        executor.shouldThrowAppleScriptError = true
        let session = makeSession(daemonClient: daemonClient, executor: executor)

        let runTask = Task { @MainActor in
            await session.run()
        }

        try? await Task.sleep(nanoseconds: 50_000_000)

        // First action is AppleScript — needs confirmation
        continuation.yield(.cuAction(makeActionMessage(
            sessionId: session.id,
            toolName: "cu_run_applescript",
            input: ["script": AnyCodable("tell application \"NonExistentApp\" to activate")],
            reasoning: "Try script",
            stepNumber: 1
        )))

        for _ in 0..<200 {
            if case .awaitingConfirmation = session.state { break }
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
        session.approveConfirmation()
        try? await Task.sleep(nanoseconds: 50_000_000)

        // The error observation should have been sent; daemon can now complete
        continuation.yield(.cuComplete(makeCompleteMessage(
            sessionId: session.id,
            summary: "Recovered from error",
            stepCount: 1
        )))

        await runTask.value

        // Should have completed (not failed) because AppleScript errors are non-fatal
        if case .completed(let summary, _) = session.state {
            XCTAssertEqual(summary, "Recovered from error")
        } else {
            XCTFail("Expected completed state (AppleScript errors are non-fatal), got \(session.state)")
        }
    }

    // MARK: - No AX Tree (Screenshot Fallback)

    @MainActor
    func testNoAXTree_usesScreenshotFallback() async {
        let daemonClient = MockDaemonClient()
        let continuation = daemonClient.setupTestStream()
        // Enumerator returns nil -> triggers screenshot fallback
        let enumerator = MockAccessibilityTreeEnumerator(result: nil)
        let session = makeSession(daemonClient: daemonClient, enumerator: enumerator)

        let runTask = Task { @MainActor in
            await session.run()
        }

        try? await Task.sleep(nanoseconds: 50_000_000)

        continuation.yield(.cuComplete(makeCompleteMessage(
            sessionId: session.id,
            summary: "Used screenshot",
            stepCount: 1
        )))

        await runTask.value

        if case .completed(let summary, _) = session.state {
            XCTAssertEqual(summary, "Used screenshot")
        } else {
            XCTFail("Expected completed state, got \(session.state)")
        }
    }

    // MARK: - Tool Name Mapping

    @MainActor
    func testToolNameMapping_allTypes() async {
        let daemonClient = MockDaemonClient()
        let continuation = daemonClient.setupTestStream()
        let executor = MockActionExecutor()
        let session = makeSession(daemonClient: daemonClient, executor: executor)

        let runTask = Task { @MainActor in
            await session.run()
        }

        try? await Task.sleep(nanoseconds: 50_000_000)

        // Test click mapping
        continuation.yield(.cuAction(makeActionMessage(
            sessionId: session.id,
            toolName: "cu_click",
            input: ["x": AnyCodable(100), "y": AnyCodable(200)],
            stepNumber: 1
        )))
        try? await Task.sleep(nanoseconds: 50_000_000)

        // Test scroll mapping
        continuation.yield(.cuAction(makeActionMessage(
            sessionId: session.id,
            toolName: "cu_scroll",
            input: ["direction": AnyCodable("down"), "amount": AnyCodable(3)],
            stepNumber: 2
        )))
        try? await Task.sleep(nanoseconds: 50_000_000)

        continuation.yield(.cuComplete(makeCompleteMessage(
            sessionId: session.id,
            summary: "Done",
            stepCount: 2
        )))

        await runTask.value

        XCTAssertEqual(executor.executedActions.count, 2)
        XCTAssertEqual(executor.executedActions[0].type, .click)
        XCTAssertEqual(executor.executedActions[0].x, 100)
        XCTAssertEqual(executor.executedActions[0].y, 200)
        XCTAssertEqual(executor.executedActions[1].type, .scroll)
        XCTAssertEqual(executor.executedActions[1].scrollDirection, "down")
        XCTAssertEqual(executor.executedActions[1].scrollAmount, 3)
    }

    // MARK: - skipSessionCreate

    @MainActor
    func testSkipSessionCreate_doesNotSendCuSessionCreate() async {
        let daemonClient = MockDaemonClient()
        let continuation = daemonClient.setupTestStream()
        let session = ComputerUseSession(
            task: "test task",
            daemonClient: daemonClient,
            enumerator: makeDefaultEnumerator(),
            screenCapture: MockScreenCapture(),
            executor: MockActionExecutor(),
            maxSteps: 50,
            initialDelayMs: 0,
            adaptiveDelay: false,
            sessionId: "daemon-assigned-id",
            skipSessionCreate: true
        )

        XCTAssertEqual(session.id, "daemon-assigned-id")

        let runTask = Task { @MainActor in
            await session.run()
        }

        try? await Task.sleep(nanoseconds: 50_000_000)

        // Should NOT have sent CuSessionCreateMessage
        let createMessages = daemonClient.sentMessages.compactMap { $0 as? CuSessionCreateMessage }
        XCTAssertEqual(createMessages.count, 0, "skipSessionCreate should prevent sending cu_session_create")

        // Should still have sent an observation
        let obsMessages = daemonClient.sentMessages.compactMap { $0 as? CuObservationMessage }
        XCTAssertGreaterThanOrEqual(obsMessages.count, 1)
        XCTAssertEqual(obsMessages[0].sessionId, "daemon-assigned-id")

        // Clean up
        continuation.yield(.cuComplete(makeCompleteMessage(
            sessionId: "daemon-assigned-id",
            summary: "Done",
            stepCount: 1
        )))
        await runTask.value
    }

    // MARK: - ServerMessage.taskRouted decoding

    @MainActor
    func testTaskRoutedDecoding() async {
        let json = """
        {"type":"task_routed","sessionId":"sess-123","interactionType":"computer_use"}
        """
        let data = json.data(using: .utf8)!
        let message = try! JSONDecoder().decode(ServerMessage.self, from: data)
        if case .taskRouted(let routed) = message {
            XCTAssertEqual(routed.sessionId, "sess-123")
            XCTAssertEqual(routed.interactionType, "computer_use")
        } else {
            XCTFail("Expected taskRouted, got \(message)")
        }
    }

    @MainActor
    func testTaskRoutedDecoding_textQA() async {
        let json = """
        {"type":"task_routed","sessionId":"sess-456","interactionType":"text_qa"}
        """
        let data = json.data(using: .utf8)!
        let message = try! JSONDecoder().decode(ServerMessage.self, from: data)
        if case .taskRouted(let routed) = message {
            XCTAssertEqual(routed.sessionId, "sess-456")
            XCTAssertEqual(routed.interactionType, "text_qa")
        } else {
            XCTFail("Expected taskRouted, got \(message)")
        }
    }

    @MainActor
    func testConfirmationRequestDecodingWithExecutionTarget() async {
        let json = """
        {"type":"confirmation_request","requestId":"req-123","toolName":"host_bash","input":{"command":"ls"},"riskLevel":"medium","allowlistOptions":[],"scopeOptions":[],"executionTarget":"host"}
        """
        let data = json.data(using: .utf8)!
        let message = try! JSONDecoder().decode(ServerMessage.self, from: data)
        if case .confirmationRequest(let request) = message {
            XCTAssertEqual(request.requestId, "req-123")
            XCTAssertEqual(request.executionTarget, "host")
        } else {
            XCTFail("Expected confirmationRequest, got \(message)")
        }
    }

    @MainActor
    func testSessionErrorDecoding() async {
        let json = """
        {"type":"session_error","sessionId":"sess-001","code":"PROVIDER_NETWORK","userMessage":"Unable to reach the AI provider.","retryable":true,"debugDetails":"ETIMEDOUT after 30000ms"}
        """
        let data = json.data(using: .utf8)!
        let message = try! JSONDecoder().decode(ServerMessage.self, from: data)
        if case .sessionError(let err) = message {
            XCTAssertEqual(err.sessionId, "sess-001")
            XCTAssertEqual(err.code, .providerNetwork)
            XCTAssertEqual(err.userMessage, "Unable to reach the AI provider.")
            XCTAssertTrue(err.retryable)
            XCTAssertEqual(err.debugDetails, "ETIMEDOUT after 30000ms")
        } else {
            XCTFail("Expected sessionError, got \(message)")
        }
    }

    @MainActor
    func testSessionErrorDecoding_withoutOptionalFields() async {
        let json = """
        {"type":"session_error","sessionId":"sess-002","code":"UNKNOWN","userMessage":"Something went wrong.","retryable":false}
        """
        let data = json.data(using: .utf8)!
        let message = try! JSONDecoder().decode(ServerMessage.self, from: data)
        if case .sessionError(let err) = message {
            XCTAssertEqual(err.sessionId, "sess-002")
            XCTAssertEqual(err.code, .unknown)
            XCTAssertEqual(err.userMessage, "Something went wrong.")
            XCTAssertFalse(err.retryable)
            XCTAssertNil(err.debugDetails)
        } else {
            XCTFail("Expected sessionError, got \(message)")
        }
    }

    @MainActor
    func testConfirmationRequestDecodingWithoutExecutionTarget() async {
        let json = """
        {"type":"confirmation_request","requestId":"req-456","toolName":"bash","input":{"command":"pwd"},"riskLevel":"low","allowlistOptions":[],"scopeOptions":[]}
        """
        let data = json.data(using: .utf8)!
        let message = try! JSONDecoder().decode(ServerMessage.self, from: data)
        if case .confirmationRequest(let request) = message {
            XCTAssertEqual(request.requestId, "req-456")
            XCTAssertNil(request.executionTarget)
        } else {
            XCTFail("Expected confirmationRequest, got \(message)")
        }
    }

}

/// Test elements with 3+ interactive elements (enough for screenshot skip)
private func makeInteractiveTestElements() -> [AXElement] {
    [
        AXElement(
            id: 1,
            role: "AXButton",
            title: "Submit",
            value: nil,
            frame: CGRect(x: 100, y: 200, width: 80, height: 30),
            isEnabled: true,
            isFocused: false,
            children: [],
            roleDescription: "button",
            identifier: nil,
            url: nil,
            placeholderValue: nil
        ),
        AXElement(
            id: 2,
            role: "AXTextField",
            title: nil,
            value: "",
            frame: CGRect(x: 100, y: 150, width: 200, height: 30),
            isEnabled: true,
            isFocused: true,
            children: [],
            roleDescription: "text field",
            identifier: nil,
            url: nil,
            placeholderValue: "Enter name"
        ),
        AXElement(
            id: 3,
            role: "AXButton",
            title: "Cancel",
            value: nil,
            frame: CGRect(x: 200, y: 200, width: 80, height: 30),
            isEnabled: true,
            isFocused: false,
            children: [],
            roleDescription: "button",
            identifier: nil,
            url: nil,
            placeholderValue: nil
        ),
        AXElement(
            id: 4,
            role: "AXCheckBox",
            title: "Remember me",
            value: "0",
            frame: CGRect(x: 100, y: 250, width: 120, height: 20),
            isEnabled: true,
            isFocused: false,
            children: [],
            roleDescription: "checkbox",
            identifier: nil,
            url: nil,
            placeholderValue: nil
        ),
    ]
}
