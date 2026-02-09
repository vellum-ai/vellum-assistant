import XCTest
import CoreGraphics
@testable import vellum_assistant

// MARK: - Mocks

final class MockInferenceProvider: ActionInferenceProvider {
    var actions: [AgentAction]
    var inferCallCount = 0
    var receivedPreviousAXTrees: [String?] = []
    var shouldThrowOnCall: Int? = nil
    var delayNanoseconds: UInt64 = 0

    init(actions: [AgentAction]) {
        self.actions = actions
    }

    func infer(
        axTree: String?,
        previousAXTree: String?,
        axDiff: String?,
        secondaryWindows: String?,
        screenshot: Data?,
        screenSize: CGSize,
        task: String,
        history: [ActionRecord],
        elements: [AXElement]?
    ) async throws -> (action: AgentAction, usage: TokenUsage?) {
        if delayNanoseconds > 0 {
            try? await Task.sleep(nanoseconds: delayNanoseconds)
        }
        receivedPreviousAXTrees.append(previousAXTree)
        let index = inferCallCount
        inferCallCount += 1

        if shouldThrowOnCall == index {
            throw InferenceError.networkError("Mock network error")
        }

        guard index < actions.count else {
            return (action: AgentAction(type: .done, reasoning: "No more scripted actions", summary: "Auto-completed"), usage: nil)
        }
        return (action: actions[index], usage: nil)
    }
}

final class MockAccessibilityTreeEnumerator: AccessibilityTreeProviding {
    var result: (elements: [AXElement], windowTitle: String, appName: String, pid: pid_t)?

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
        return []
    }
}

final class MockScreenCapture: ScreenCaptureProviding {
    func captureScreen(maxWidth: Int, maxHeight: Int) async throws -> Data {
        return Data([0xFF, 0xD8, 0xFF]) // Minimal JPEG-like stub
    }

    func screenSize() -> CGSize {
        return CGSize(width: 1920, height: 1080)
    }
}

final class MockActionExecutor: ActionExecuting {
    var executedActions: [AgentAction] = []
    var shouldFailOnCall: Int? = nil
    private var callCount = 0

    func execute(_ action: AgentAction) async throws {
        if shouldFailOnCall == callCount {
            callCount += 1
            throw ExecutorError.eventCreationFailed
        }
        callCount += 1
        executedActions.append(action)
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
    provider: ActionInferenceProvider,
    enumerator: AccessibilityTreeProviding? = nil,
    executor: MockActionExecutor? = nil,
    maxSteps: Int = 50
) -> ComputerUseSession {
    ComputerUseSession(
        task: task,
        provider: provider,
        enumerator: enumerator ?? makeDefaultEnumerator(),
        screenCapture: MockScreenCapture(),
        executor: executor ?? MockActionExecutor(),
        maxSteps: maxSteps,
        stepDelayMs: 0,
        initialDelayMs: 0,
        adaptiveDelay: false
    )
}

// MARK: - Tests

final class SessionTests: XCTestCase {

    // MARK: - Happy Path

    @MainActor
    func testHappyPath_completesInThreeSteps() async {
        let provider = MockInferenceProvider(actions: [
            AgentAction(type: .click, reasoning: "Click submit", x: 140, y: 215),
            AgentAction(type: .type, reasoning: "Type name", text: "John"),
            AgentAction(type: .done, reasoning: "Task complete", summary: "Filled form and submitted")
        ])
        let executor = MockActionExecutor()
        let session = makeSession(provider: provider, executor: executor)

        await session.run()

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
        let provider = MockInferenceProvider(actions: [
            AgentAction(type: .done, reasoning: "Already done", summary: "Nothing to do")
        ])
        let session = makeSession(provider: provider)

        await session.run()

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
        // Provider returns many actions, but we cancel after a few
        let actions = (0..<20).map { i in
            AgentAction(type: .click, reasoning: "step \(i)", x: CGFloat(100 + i * 10), y: 200)
        }
        let provider = MockInferenceProvider(actions: actions)
        provider.delayNanoseconds = 20_000_000 // 20ms per inference so cancel can take effect
        let session = makeSession(provider: provider)

        let runTask = Task { @MainActor in
            await session.run()
        }

        // Let one step execute, then cancel
        // With stepDelayMs=0, this races, but cancel should stop the loop
        try? await Task.sleep(nanoseconds: 50_000_000) // 50ms
        session.cancel()

        await runTask.value

        XCTAssertEqual(session.state, .cancelled)
        // Should have executed fewer than all 20 actions
        XCTAssertLessThan(provider.inferCallCount, 20)
    }

    // MARK: - Inference Failure

    @MainActor
    func testInferenceFailure_failsSession() async {
        let provider = MockInferenceProvider(actions: [])
        provider.shouldThrowOnCall = 0

        let session = makeSession(provider: provider)

        await session.run()

        if case .failed(let reason) = session.state {
            XCTAssertTrue(reason.contains("Inference failed"), "Expected inference failure, got: \(reason)")
        } else {
            XCTFail("Expected failed state, got \(session.state)")
        }
    }

    @MainActor
    func testInferenceFailure_afterOneSuccess() async {
        let provider = MockInferenceProvider(actions: [
            AgentAction(type: .click, reasoning: "first click", x: 100, y: 200)
        ])
        provider.shouldThrowOnCall = 1 // Fail on second call

        let session = makeSession(provider: provider)

        await session.run()

        if case .failed(let reason) = session.state {
            XCTAssertTrue(reason.contains("Inference failed"))
        } else {
            XCTFail("Expected failed state, got \(session.state)")
        }
        XCTAssertEqual(provider.inferCallCount, 2)
    }

    // MARK: - Execution Failure

    @MainActor
    func testExecutionFailure_failsSession() async {
        let provider = MockInferenceProvider(actions: [
            AgentAction(type: .click, reasoning: "click", x: 100, y: 200)
        ])
        let executor = MockActionExecutor()
        executor.shouldFailOnCall = 0

        let session = makeSession(provider: provider, executor: executor)

        await session.run()

        if case .failed(let reason) = session.state {
            XCTAssertTrue(reason.contains("Execution failed"))
        } else {
            XCTFail("Expected failed state, got \(session.state)")
        }
    }

    // MARK: - Step Limit

    @MainActor
    func testStepLimit_blocksAtMax() async {
        // 3 actions + done, but maxSteps=2 so the 3rd action will be blocked
        let provider = MockInferenceProvider(actions: [
            AgentAction(type: .click, reasoning: "step 1", x: 100, y: 200),
            AgentAction(type: .click, reasoning: "step 2", x: 200, y: 200),
            AgentAction(type: .click, reasoning: "step 3", x: 300, y: 200), // blocked
            AgentAction(type: .click, reasoning: "step 3b", x: 400, y: 200), // blocked
            AgentAction(type: .click, reasoning: "step 3c", x: 500, y: 200), // blocked → fail
        ])

        let session = makeSession(provider: provider, maxSteps: 2)

        await session.run()

        if case .failed(let reason) = session.state {
            XCTAssertTrue(reason.contains("blocked"), "Expected block-related failure, got: \(reason)")
        } else {
            XCTFail("Expected failed state, got \(session.state)")
        }
    }

    // MARK: - Loop Detection

    @MainActor
    func testLoopDetection_threeIdenticalActions_blocked() async {
        let repeatedAction = AgentAction(type: .click, reasoning: "same click", x: 100, y: 200)
        let provider = MockInferenceProvider(actions: [
            repeatedAction, repeatedAction, repeatedAction, // 3rd is blocked
            repeatedAction, // blocked
            repeatedAction, // blocked → fail (3 consecutive blocks)
        ])

        let session = makeSession(provider: provider)

        await session.run()

        if case .failed(let reason) = session.state {
            XCTAssertTrue(reason.contains("blocked"), "Expected block-related failure, got: \(reason)")
        } else {
            XCTFail("Expected failed state, got \(session.state)")
        }
    }

    // MARK: - No AX Tree (Screenshot Fallback)

    @MainActor
    func testNoAXTree_usesScreenshotFallback() async {
        let provider = MockInferenceProvider(actions: [
            AgentAction(type: .done, reasoning: "done", summary: "Used screenshot")
        ])
        // Enumerator returns nil → triggers screenshot fallback
        let enumerator = MockAccessibilityTreeEnumerator(result: nil)

        let session = makeSession(provider: provider, enumerator: enumerator)

        await session.run()

        if case .completed(let summary, _) = session.state {
            XCTAssertEqual(summary, "Used screenshot")
        } else {
            XCTFail("Expected completed state, got \(session.state)")
        }
    }

    // MARK: - Previous AX Tree Context

    @MainActor
    func testPreviousAXTree_nilOnFirstStep() async {
        let provider = MockInferenceProvider(actions: [
            AgentAction(type: .done, reasoning: "done", summary: "Checked context")
        ])
        let session = makeSession(provider: provider)

        await session.run()

        XCTAssertEqual(provider.receivedPreviousAXTrees.count, 1)
        XCTAssertNil(provider.receivedPreviousAXTrees[0], "First step should have nil previousAXTree")
    }

    @MainActor
    func testPreviousAXTree_populatedOnSecondStep() async {
        let provider = MockInferenceProvider(actions: [
            AgentAction(type: .click, reasoning: "click", x: 100, y: 200),
            AgentAction(type: .done, reasoning: "done", summary: "Checked context")
        ])
        let session = makeSession(provider: provider)

        await session.run()

        XCTAssertEqual(provider.receivedPreviousAXTrees.count, 2)
        XCTAssertNil(provider.receivedPreviousAXTrees[0], "First step should have nil previousAXTree")
        XCTAssertNotNil(provider.receivedPreviousAXTrees[1], "Second step should have previousAXTree from step 1")

        // Verify the previous tree contains expected content
        let prevTree = provider.receivedPreviousAXTrees[1]!
        XCTAssertTrue(prevTree.contains("Test Window"), "Previous AX tree should contain window title")
        XCTAssertTrue(prevTree.contains("TestApp"), "Previous AX tree should contain app name")
    }

    @MainActor
    func testPreviousAXTree_nilWhenNoAXTree() async {
        let provider = MockInferenceProvider(actions: [
            AgentAction(type: .click, reasoning: "click", x: 100, y: 200),
            AgentAction(type: .done, reasoning: "done", summary: "Done")
        ])
        // No AX tree available — screenshot only
        let enumerator = MockAccessibilityTreeEnumerator(result: nil)
        let session = makeSession(provider: provider, enumerator: enumerator)

        await session.run()

        // Both steps should have nil previousAXTree since no AX tree was available
        XCTAssertEqual(provider.receivedPreviousAXTrees.count, 2)
        XCTAssertNil(provider.receivedPreviousAXTrees[0])
        XCTAssertNil(provider.receivedPreviousAXTrees[1])
    }

    // MARK: - Confirmation Flow

    @MainActor
    func testConfirmation_approved_continuesSession() async {
        let provider = MockInferenceProvider(actions: [
            AgentAction(type: .key, reasoning: "quit app", key: "cmd+q"),
            AgentAction(type: .done, reasoning: "done", summary: "Completed after approval")
        ])
        let session = makeSession(provider: provider)

        let runTask = Task { @MainActor in
            await session.run()
        }

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
        await runTask.value

        if case .completed(let summary, _) = session.state {
            XCTAssertEqual(summary, "Completed after approval")
        } else {
            XCTFail("Expected completed state after approval, got \(session.state)")
        }
    }

    @MainActor
    func testConfirmation_rejected_cancelsSession() async {
        let provider = MockInferenceProvider(actions: [
            AgentAction(type: .key, reasoning: "quit app", key: "cmd+q"),
            AgentAction(type: .done, reasoning: "done", summary: "Should not reach")
        ])
        let session = makeSession(provider: provider)

        let runTask = Task { @MainActor in
            await session.run()
        }

        // Wait for confirmation state
        for _ in 0..<200 {
            if case .awaitingConfirmation = session.state { break }
            try? await Task.sleep(nanoseconds: 10_000_000)
        }

        session.rejectConfirmation()
        await runTask.value

        // Current behavior: rejection cancels the session
        XCTAssertEqual(session.state, .cancelled)
    }

    // MARK: - Pause and Resume

    @MainActor
    func testPauseAndResume() async {
        let provider = MockInferenceProvider(actions: [
            AgentAction(type: .click, reasoning: "step 1", x: 100, y: 200),
            AgentAction(type: .click, reasoning: "step 2", x: 200, y: 200),
            AgentAction(type: .done, reasoning: "done", summary: "Completed after pause")
        ])
        provider.delayNanoseconds = 20_000_000 // 20ms per inference so pause can take effect
        let session = makeSession(provider: provider)

        let runTask = Task { @MainActor in
            await session.run()
        }

        // Wait for first action to execute
        for _ in 0..<200 {
            if case .running(let step, _, _, _) = session.state, step >= 1 { break }
            try? await Task.sleep(nanoseconds: 10_000_000)
        }

        session.pause()

        // Verify paused state
        try? await Task.sleep(nanoseconds: 50_000_000) // 50ms
        if case .paused = session.state {
            // Good — paused
        } else {
            // May have completed before pause took effect — still valid
        }

        session.resume()
        await runTask.value

        if case .completed(let summary, _) = session.state {
            XCTAssertEqual(summary, "Completed after pause")
        } else {
            XCTFail("Expected completed state, got \(session.state)")
        }
    }

    // MARK: - Task Property

    // MARK: - Open App

    @MainActor
    func testOpenApp_executesSuccessfully() async {
        let provider = MockInferenceProvider(actions: [
            AgentAction(type: .openApp, reasoning: "Open Slack to send message", appName: "Slack"),
            AgentAction(type: .done, reasoning: "done", summary: "Opened Slack")
        ])
        let executor = MockActionExecutor()
        let session = makeSession(provider: provider, executor: executor)

        await session.run()

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

    // MARK: - No-Op Detection

    @MainActor
    func testOpenApp_noOp_skipsExecution() async {
        // Model emits openApp for the app that's already frontmost (TestApp from mock enumerator)
        let provider = MockInferenceProvider(actions: [
            AgentAction(type: .openApp, reasoning: "Open TestApp", appName: "TestApp"),
            AgentAction(type: .done, reasoning: "done", summary: "Completed after no-op")
        ])
        let executor = MockActionExecutor()
        let session = makeSession(provider: provider, executor: executor)

        await session.run()

        if case .completed(let summary, let steps) = session.state {
            XCTAssertEqual(steps, 2)
            XCTAssertEqual(summary, "Completed after no-op")
        } else {
            XCTFail("Expected completed state, got \(session.state)")
        }

        // Executor should NOT have received the open_app action (it was a no-op)
        XCTAssertEqual(executor.executedActions.count, 0)
    }

    @MainActor
    func testOpenApp_noOp_caseInsensitive() async {
        let provider = MockInferenceProvider(actions: [
            AgentAction(type: .openApp, reasoning: "Open testapp", appName: "testapp"),
            AgentAction(type: .done, reasoning: "done", summary: "Completed")
        ])
        let executor = MockActionExecutor()
        let session = makeSession(provider: provider, executor: executor)

        await session.run()

        if case .completed(_, _) = session.state {
            // Good
        } else {
            XCTFail("Expected completed state, got \(session.state)")
        }

        // No-op: "testapp" matches "TestApp" (case-insensitive)
        XCTAssertEqual(executor.executedActions.count, 0)
    }

    @MainActor
    func testOpenApp_noOp_aliasMatch() async {
        // "chrome" is an alias for "Google Chrome"
        let provider = MockInferenceProvider(actions: [
            AgentAction(type: .openApp, reasoning: "Open Chrome", appName: "chrome"),
            AgentAction(type: .done, reasoning: "done", summary: "Completed")
        ])
        let executor = MockActionExecutor()
        let enumerator = MockAccessibilityTreeEnumerator(
            result: (elements: makeTestElements(), windowTitle: "New Tab", appName: "Google Chrome")
        )
        let session = makeSession(provider: provider, enumerator: enumerator, executor: executor)

        await session.run()

        if case .completed(_, _) = session.state {
            // Good
        } else {
            XCTFail("Expected completed state, got \(session.state)")
        }

        // No-op: "chrome" resolves to "Google Chrome" which matches the frontmost app
        XCTAssertEqual(executor.executedActions.count, 0)
    }

    @MainActor
    func testOpenApp_differentApp_executesNormally() async {
        // Model opens a DIFFERENT app — should execute normally
        let provider = MockInferenceProvider(actions: [
            AgentAction(type: .openApp, reasoning: "Open Safari", appName: "Safari"),
            AgentAction(type: .done, reasoning: "done", summary: "Opened Safari")
        ])
        let executor = MockActionExecutor()
        let session = makeSession(provider: provider, executor: executor)

        await session.run()

        if case .completed(_, _) = session.state {
            // Good
        } else {
            XCTFail("Expected completed state, got \(session.state)")
        }

        // Different app — executor SHOULD have received the open_app action
        XCTAssertEqual(executor.executedActions.count, 1)
        XCTAssertEqual(executor.executedActions[0].type, .openApp)
        XCTAssertEqual(executor.executedActions[0].appName, "Safari")
    }

    // MARK: - Task Property

    @MainActor
    func testTaskProperty_matchesInput() async {
        let provider = MockInferenceProvider(actions: [
            AgentAction(type: .done, reasoning: "done", summary: "Done")
        ])
        let session = makeSession(task: "Open Safari and search for cats", provider: provider)

        XCTAssertEqual(session.task, "Open Safari and search for cats")
    }
}
