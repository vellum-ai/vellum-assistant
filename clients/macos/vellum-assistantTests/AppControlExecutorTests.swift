#if os(macOS)
import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

final class AppControlExecutorTests: XCTestCase {

    // MARK: - .start with unknown bundle ID

    /// A bundle ID that no installed app advertises should resolve to neither
    /// a running PID nor a launchable URL — `perform` must surface that as a
    /// `.missing` result with a non-empty `executionError` rather than throwing.
    func test_start_unknownBundleId_returnsMissingWithError() async {
        let request = HostAppControlRequest(
            type: "host_app_control_request",
            requestId: "req-start-missing",
            conversationId: "conv-test",
            input: .start(app: "com.example.does-not-exist", args: nil)
        )

        let result = await AppControlExecutor.perform(request)

        XCTAssertEqual(result.requestId, "req-start-missing")
        XCTAssertEqual(result.state, .missing)
        let error = result.executionError ?? ""
        XCTAssertFalse(error.isEmpty, "Expected non-empty executionError; got: \(error)")
    }

    // MARK: - .stop is always a no-op success

    /// `.stop` is a session-acknowledgement signal and does not terminate the
    /// target app. It must succeed for any input — including a bogus name —
    /// and never throw.
    func test_stop_alwaysReturnsStoppedRegardlessOfApp() async {
        let request = HostAppControlRequest(
            type: "host_app_control_request",
            requestId: "req-stop-1",
            conversationId: "conv-test",
            input: .stop(app: "com.example.does-not-exist", reason: "test")
        )

        let result = await AppControlExecutor.perform(request)

        XCTAssertEqual(result.requestId, "req-stop-1")
        XCTAssertEqual(result.state, .running)
        XCTAssertEqual(result.executionResult, "session stopped")
        XCTAssertNil(result.executionError)
    }

    func test_stop_withNilApp_alsoReturnsStopped() async {
        let request = HostAppControlRequest(
            type: "host_app_control_request",
            requestId: "req-stop-2",
            conversationId: "conv-test",
            input: .stop(app: nil, reason: nil)
        )

        let result = await AppControlExecutor.perform(request)

        XCTAssertEqual(result.requestId, "req-stop-2")
        XCTAssertEqual(result.state, .running)
        XCTAssertEqual(result.executionResult, "session stopped")
        XCTAssertNil(result.executionError)
    }

    // MARK: - .observe with unresolvable name

    /// Observe with a name that resolves to no running process should report
    /// `.missing` rather than crashing or hanging.
    func test_observe_unknownApp_returnsMissing() async {
        let request = HostAppControlRequest(
            type: "host_app_control_request",
            requestId: "req-observe-missing",
            conversationId: "conv-test",
            input: .observe(app: "com.example.does-not-exist", settleMs: 0)
        )

        let result = await AppControlExecutor.perform(request)

        XCTAssertEqual(result.requestId, "req-observe-missing")
        XCTAssertEqual(result.state, .missing)
        XCTAssertNil(result.windowBounds)
        XCTAssertNil(result.pngBase64)
    }

    // MARK: - bounds-missing executionError selection

    /// When ScreenCaptureKit fails (commonly: Screen Recording permission
    /// missing), the capture surfaces a `captureError` even though the window
    /// state may be `.running` or `.minimized`. The bounds-missing branch of
    /// click/drag must propagate that message verbatim — that's the new signal
    /// users need so they know to grant the permission.
    func test_boundsMissingExecutionError_prefersCaptureError() {
        let capture = AppWindowCapture.CaptureResult(
            state: .running,
            pngBase64: nil,
            bounds: nil,
            captureError: "Screen capture failed: permission denied — Screen Recording permission may be required"
        )
        let message = AppControlExecutor.boundsMissingExecutionError(capture)
        XCTAssertEqual(
            message,
            "Screen capture failed: permission denied — Screen Recording permission may be required"
        )
    }

    /// Falls back to a state-classification message when capture itself
    /// succeeded (no captureError) but bounds are still unavailable — e.g.
    /// the app is minimized to the Dock.
    func test_boundsMissingExecutionError_fallsBackToStateMessage() {
        let capture = AppWindowCapture.CaptureResult(
            state: .minimized,
            pngBase64: nil,
            bounds: nil,
            captureError: nil
        )
        let message = AppControlExecutor.boundsMissingExecutionError(capture)
        XCTAssertEqual(message, "Window not visible (state=minimized)")
    }

    /// Even for `.missing` (process gone), the helper still returns a
    /// non-empty fallback so click/drag never hand the daemon an empty error.
    func test_boundsMissingExecutionError_missingState_hasFallback() {
        let capture = AppWindowCapture.CaptureResult(
            state: .missing,
            pngBase64: nil,
            bounds: nil,
            captureError: nil
        )
        let message = AppControlExecutor.boundsMissingExecutionError(capture)
        XCTAssertEqual(message, "Window not visible (state=missing)")
    }
}
#endif
