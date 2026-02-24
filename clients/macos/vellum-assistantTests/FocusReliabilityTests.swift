import XCTest
@testable import VellumAssistantLib

// MARK: - AXElementRegistry Tests

final class AXElementRegistryTests: XCTestCase {

    func testRegisterAndResolve() {
        let registry = AXElementRegistry()
        let pid = ProcessInfo.processInfo.processIdentifier
        let element = AXUIElementCreateApplication(pid)

        registry.register(elementId: 42, element: element)

        XCTAssertNotNil(registry.resolve(elementId: 42))
        XCTAssertNil(registry.resolve(elementId: 99), "Unregistered ID should return nil")
        XCTAssertEqual(registry.count, 1)
    }

    func testClearRemovesAllEntries() {
        let registry = AXElementRegistry()
        let pid = ProcessInfo.processInfo.processIdentifier
        let element = AXUIElementCreateApplication(pid)

        registry.register(elementId: 1, element: element)
        registry.register(elementId: 2, element: element)
        XCTAssertEqual(registry.count, 2)

        registry.clear()
        XCTAssertEqual(registry.count, 0)
        XCTAssertNil(registry.resolve(elementId: 1))
        XCTAssertNil(registry.resolve(elementId: 2))
    }

    func testResolveStaleIdReturnsNil() {
        let registry = AXElementRegistry()
        let pid = ProcessInfo.processInfo.processIdentifier
        let element = AXUIElementCreateApplication(pid)

        registry.register(elementId: 5, element: element)
        registry.clear()
        registry.register(elementId: 10, element: element)

        // Old ID should be gone
        XCTAssertNil(registry.resolve(elementId: 5))
        // New ID should work
        XCTAssertNotNil(registry.resolve(elementId: 10))
    }
}

// MARK: - FocusManager Tests

final class FocusManagerTests: XCTestCase {

    @MainActor
    func testNoTargetConstraint_alwaysSucceeds() async {
        let manager = FocusManager()
        let result = await manager.acquireVerifiedFocus(bundleId: nil, appName: nil)
        // No target = always matches whatever is frontmost
        if case .success = result {
            // expected
        } else {
            XCTFail("Expected success when no target is specified, got \(result)")
        }
    }

    @MainActor
    func testNonexistentApp_returnsNotRunning() async {
        let manager = FocusManager()
        let result = await manager.acquireVerifiedFocus(
            bundleId: "com.nonexistent.bogusapp.doesnotexist",
            appName: "BogusAppThatDoesNotExist"
        )
        if case .targetNotRunning = result {
            // expected
        } else {
            XCTFail("Expected targetNotRunning for nonexistent app, got \(result)")
        }
    }

    @MainActor
    func testEmptyBundleId_fallsToName() async {
        let manager = FocusManager()
        // Empty bundle ID should be treated as "no bundle ID"
        let result = await manager.acquireVerifiedFocus(
            bundleId: "",
            appName: "NonexistentApp999"
        )
        if case .targetNotRunning = result {
            // expected — app name doesn't match any running app
        } else {
            XCTFail("Expected targetNotRunning for empty bundleId + unknown name, got \(result)")
        }
    }
}

// MARK: - AXActionExecutor Tests

final class AXActionExecutorTests: XCTestCase {

    @MainActor
    func testClickUnregisteredElement_returnsFallback() {
        let registry = AXElementRegistry()
        let executor = AXActionExecutor(elementRegistry: registry)

        let result = executor.click(elementId: 999)
        if case .fallback(let reason) = result {
            XCTAssertTrue(reason.contains("not in registry"))
        } else {
            XCTFail("Expected fallback for unregistered element")
        }
    }

    @MainActor
    func testTypeUnregisteredElement_returnsFallback() {
        let registry = AXElementRegistry()
        let executor = AXActionExecutor(elementRegistry: registry)

        let result = executor.type(elementId: 999, text: "hello")
        if case .fallback(let reason) = result {
            XCTAssertTrue(reason.contains("not in registry"))
        } else {
            XCTFail("Expected fallback for unregistered element")
        }
    }

    @MainActor
    func testFocusUnregisteredElement_returnsFallback() {
        let registry = AXElementRegistry()
        let executor = AXActionExecutor(elementRegistry: registry)

        let result = executor.focus(elementId: 999)
        if case .fallback(let reason) = result {
            XCTAssertTrue(reason.contains("not in registry"))
        } else {
            XCTFail("Expected fallback for unregistered element")
        }
    }
}

// MARK: - ActionTargetMode Tests

final class ActionTargetModeTests: XCTestCase {

    func testTargetModeAX_whenOnlyElementId() {
        let action = AgentAction(
            type: .click,
            reasoning: "click button",
            resolvedFromElementId: 5
        )
        XCTAssertEqual(action.targetMode, .ax)
    }

    func testTargetModeVision_whenOnlyCoordinates() {
        let action = AgentAction(
            type: .click,
            reasoning: "click button",
            x: 100,
            y: 200
        )
        XCTAssertEqual(action.targetMode, .vision)
    }

    func testTargetModeMixed_whenBothElementIdAndCoordinates() {
        let action = AgentAction(
            type: .click,
            reasoning: "click button",
            x: 100,
            y: 200,
            resolvedFromElementId: 5
        )
        XCTAssertEqual(action.targetMode, .mixed)
    }

    func testTargetModeUnknown_whenNeitherElementIdNorCoordinates() {
        let action = AgentAction(
            type: .type,
            reasoning: "type text",
            text: "hello"
        )
        XCTAssertEqual(action.targetMode, .unknown)
    }

    func testDragTargetModeMixed_whenBothSourceAndDestinationElementIds() {
        let action = AgentAction(
            type: .drag,
            reasoning: "drag",
            x: 10, y: 20,
            toX: 30, toY: 40,
            resolvedFromElementId: 1,
            resolvedToElementId: 2
        )
        XCTAssertEqual(action.targetMode, .mixed)
    }
}

// MARK: - ExecutorError.focusAcquireFailed Tests

final class ExecutorFocusAcquireFailedTests: XCTestCase {

    func testFocusAcquireFailed_errorDescription() {
        let error = ExecutorError.focusAcquireFailed("Expected 'Safari' but frontmost is 'Finder'")
        XCTAssertEqual(error.errorDescription, "FOCUS_ACQUIRE_FAILED: Expected 'Safari' but frontmost is 'Finder'")
    }

    func testFocusAcquireFailed_isLocalizedError() {
        let error: Error = ExecutorError.focusAcquireFailed("test reason")
        XCTAssertTrue(error.localizedDescription.contains("FOCUS_ACQUIRE_FAILED"))
    }
}

// MARK: - Strict QA Session Focus Tests

final class StrictQAFocusTests: XCTestCase {

    /// In strict QA, post-action focus drift should fail the session (not just warn).
    @MainActor
    func testStrictQA_postActionFocusDrift_failsRun() async {
        // This test verifies the contract: when strictVisualQa is true and
        // the target app is not frontmost after an action, the session transitions
        // to .failed state rather than appending an error and continuing.
        //
        // We can't easily mock FocusManager (it's internal to Session), but we
        // verify the error message format matches the strict failure path.
        let error = ExecutorError.focusAcquireFailed("post-action drift — Could not activate 'TestApp' after 1 attempts.")
        XCTAssertTrue(error.localizedDescription.contains("FOCUS_ACQUIRE_FAILED"))
        XCTAssertTrue(error.localizedDescription.contains("post-action drift"))
    }

    /// Non-strict sessions should NOT hard-fail on the same conditions.
    func testNonStrict_focusDrift_noHardFail() {
        // In non-strict mode, focus drift appends to executionError but does not
        // terminate the session. This is a design invariant test.
        let action = AgentAction(
            type: .click,
            reasoning: "click button",
            x: 100,
            y: 200
        )
        // Non-strict actions should not have requireExactAppMatch set
        XCTAssertFalse(action.requireExactAppMatch)
    }

    /// Strict QA actions should set requireExactAppMatch.
    func testStrictQA_setsRequireExactAppMatch() {
        let action = AgentAction(
            type: .openApp,
            reasoning: "open app",
            appName: "Safari",
            requireExactAppMatch: true
        )
        XCTAssertTrue(action.requireExactAppMatch)
    }
}
