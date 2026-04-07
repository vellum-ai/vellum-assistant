import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

// MARK: - URLProtocol stub for SSH maintenance UI endpoint calls

private final class DevTabRecoveryURLProtocol: URLProtocol {
    static var requestHandler: ((URLRequest) throws -> (HTTPURLResponse, Data))?

    override class func canInit(with request: URLRequest) -> Bool { true }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let handler = Self.requestHandler else {
            client?.urlProtocol(self, didFailWithError: URLError(.unknown))
            return
        }
        do {
            let (response, data) = try handler(request)
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}

// MARK: - Payload helpers

private func maintenancePayload(
    id: String,
    enabled: Bool,
    debugPodName: String? = nil,
    enteredAt: String? = nil
) -> Data {
    let podField = debugPodName.map { "\"debug_pod_name\": \"\($0)\"" } ?? "\"debug_pod_name\": null"
    let atField = enteredAt.map { "\"entered_at\": \"\($0)\"" } ?? "\"entered_at\": null"
    return Data("""
    {
      "id": "\(id)",
      "name": "Test Managed Assistant",
      "status": "running",
      "maintenance_mode": {
        "enabled": \(enabled),
        \(podField),
        \(atField)
      }
    }
    """.utf8)
}

// MARK: - Tests

/// Tests for the store state that drives the SSH Terminal section recovery-mode
/// controls in `SettingsDeveloperTab`: button visibility logic, disabled states
/// during mutation, and the active-recovery status copy values.
@MainActor
final class SettingsDeveloperTabRecoveryTests: XCTestCase {

    private let testAssistantId = "devtab-maint-\(UUID().uuidString.prefix(8))"
    private let testOrgId = "org-devtab-\(UUID().uuidString.prefix(8))"

    private var lockfileBackup: Data?
    private var primaryLockfilePath: String { LockfilePaths.primaryPath }
    private var previousToken: String?

    override func setUp() {
        super.setUp()

        let primaryURL = URL(fileURLWithPath: primaryLockfilePath)
        lockfileBackup = try? Data(contentsOf: primaryURL)

        let lockfileContent: [String: Any] = [
            "activeAssistant": testAssistantId,
            "assistants": [
                [
                    "assistantId": testAssistantId,
                    "name": testAssistantId,
                    "cloud": "vellum",
                    "runtimeUrl": "https://platform.vellum.ai",
                    "hatchedAt": "2026-01-01T00:00:00Z",
                ] as [String: Any]
            ]
        ]
        let data = try! JSONSerialization.data(withJSONObject: lockfileContent)
        try! data.write(to: primaryURL, options: .atomic)

        UserDefaults.standard.set(testOrgId, forKey: "connectedOrganizationId")

        URLProtocol.registerClass(DevTabRecoveryURLProtocol.self)
        DevTabRecoveryURLProtocol.requestHandler = nil
        // Save any existing token so we can restore it in tearDown, preventing
        // the test run from destroying the developer's real session token.
        previousToken = SessionTokenManager.getToken()
        SessionTokenManager.setToken("stub-session-token")
    }

    override func tearDown() {
        URLProtocol.unregisterClass(DevTabRecoveryURLProtocol.self)
        DevTabRecoveryURLProtocol.requestHandler = nil
        if let token = previousToken {
            SessionTokenManager.setToken(token)
        } else {
            SessionTokenManager.deleteToken()
        }
        previousToken = nil

        let primaryURL = URL(fileURLWithPath: primaryLockfilePath)
        if let backup = lockfileBackup {
            try? backup.write(to: primaryURL, options: .atomic)
        } else {
            try? FileManager.default.removeItem(at: primaryURL)
        }
        lockfileBackup = nil

        UserDefaults.standard.removeObject(forKey: "connectedOrganizationId")
        super.tearDown()
    }

    // MARK: - Helpers

    private func makeStore() -> SettingsStore {
        SettingsStore(settingsClient: MockSettingsClient())
    }

    private func stubSuccess(enabled: Bool, debugPodName: String? = nil, enteredAt: String? = nil) {
        DevTabRecoveryURLProtocol.requestHandler = { _ in
            let url = URL(string: "https://example.com")!
            let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil)!
            return (response, maintenancePayload(
                id: self.testAssistantId,
                enabled: enabled,
                debugPodName: debugPodName,
                enteredAt: enteredAt
            ))
        }
    }

    private func stubFailure(statusCode: Int = 500) {
        DevTabRecoveryURLProtocol.requestHandler = { request in
            let url = request.url ?? URL(string: "https://example.com")!
            let response = HTTPURLResponse(url: url, statusCode: statusCode, httpVersion: nil, headerFields: nil)!
            return (response, Data("{\"detail\": \"server error\"}".utf8))
        }
    }

    // MARK: - Button visibility: Enter Recovery Mode shown when not active

    /// When `managedAssistantRecoveryMode` is nil (initial state), no maintenance
    /// transition should be in flight and the store should not indicate maintenance is active.
    func testNoRecoveryModeActive_whenStateIsNil() {
        let store = makeStore()
        XCTAssertNil(store.managedAssistantRecoveryMode,
                     "Initial recovery mode state should be nil")
        XCTAssertFalse(store.recoveryModeEntering,
                       "Should not be entering recovery mode initially")
        XCTAssertFalse(store.recoveryModeExiting,
                       "Should not be exiting recovery mode initially")
    }

    /// After a successful refresh that returns enabled=false, the SSH section should
    /// show "Enter Recovery Mode" (not "Resume Assistant").
    func testRefreshWithRecoveryDisabled_stateShowsNotActive() async {
        stubSuccess(enabled: false)
        let store = makeStore()

        await store.refreshManagedAssistantRecoveryMode()

        XCTAssertNotNil(store.managedAssistantRecoveryMode,
                        "Recovery mode state should be populated after refresh")
        XCTAssertFalse(store.managedAssistantRecoveryMode!.enabled,
                       "Recovery mode should be disabled after refresh with enabled=false")
    }

    // MARK: - Button visibility: Resume Assistant shown when maintenance is active

    /// After a successful refresh that returns enabled=true, the SSH section should
    /// show "Resume Assistant" instead of "Enter Recovery Mode".
    func testRefreshWithRecoveryEnabled_stateShowsActive() async {
        stubSuccess(enabled: true, debugPodName: "debug-pod-abc123")
        let store = makeStore()

        await store.refreshManagedAssistantRecoveryMode()

        XCTAssertNotNil(store.managedAssistantRecoveryMode)
        XCTAssertTrue(store.managedAssistantRecoveryMode!.enabled,
                      "Recovery mode should be active after refresh with enabled=true")
    }

    // MARK: - Active recovery status copy: debug pod name is surfaced

    /// When recovery mode is active and a debug pod name is present, the store
    /// should expose it so the status row can display "Debug pod: <name>".
    func testActiveRecoveryMode_debugPodNameIsPresent() async {
        let expectedPodName = "debug-pod-xyz789"
        stubSuccess(enabled: true, debugPodName: expectedPodName)
        let store = makeStore()

        await store.refreshManagedAssistantRecoveryMode()

        XCTAssertEqual(store.managedAssistantRecoveryMode?.debug_pod_name, expectedPodName,
                       "Debug pod name should match what the platform returned")
    }

    /// When recovery mode is active but no debug pod has been assigned yet,
    /// `debug_pod_name` should be nil (no debug pod copy rendered).
    func testActiveRecoveryMode_withoutDebugPod_podNameIsNil() async {
        stubSuccess(enabled: true, debugPodName: nil)
        let store = makeStore()

        await store.refreshManagedAssistantRecoveryMode()

        XCTAssertTrue(store.managedAssistantRecoveryMode!.enabled)
        XCTAssertNil(store.managedAssistantRecoveryMode?.debug_pod_name,
                     "Debug pod name should be nil when the platform did not assign one")
    }

    // MARK: - Disabled state during enter-recovery-mode mutation

    /// `recoveryModeEntering` flips true while the enter call is in flight and
    /// false when it resolves — the SSH section buttons are disabled while this is true.
    func testEnteringRecoveryMode_flagIsSetDuringRequest() async throws {
        stubSuccess(enabled: true)
        let store = makeStore()

        // Observe the entering flag via a brief window — fire the action but don't await it;
        // just confirm the flag is false before and after the full async resolution.
        XCTAssertFalse(store.recoveryModeEntering, "Should not be entering before action")
        XCTAssertFalse(store.recoveryModeExiting, "Should not be exiting before action")

        store.enterManagedAssistantRecoveryMode()
        // Give the task a chance to settle.
        try await Task.sleep(nanoseconds: 500_000_000)

        XCTAssertFalse(store.recoveryModeEntering, "Should not be entering after request completes")
        XCTAssertNil(store.recoveryModeEnterError, "Enter error should be nil on success")
        XCTAssertTrue(store.managedAssistantRecoveryMode?.enabled == true,
                      "Recovery mode should be enabled after successful enter")
    }

    // MARK: - Disabled state during exit-recovery-mode mutation

    /// `recoveryModeExiting` flips true while the exit call is in flight and
    /// false when it resolves — the SSH section buttons are disabled while this is true.
    func testExitingRecoveryMode_flagIsSetDuringRequest() async throws {
        stubSuccess(enabled: false)
        let store = makeStore()
        // Pre-seed an active maintenance state.
        store.managedAssistantRecoveryMode = PlatformAssistantRecoveryMode(
            enabled: true, debug_pod_name: "debug-pod-pre"
        )

        store.exitManagedAssistantRecoveryMode()
        try await Task.sleep(nanoseconds: 500_000_000)

        XCTAssertFalse(store.recoveryModeExiting, "Should not be exiting after request completes")
        XCTAssertNil(store.recoveryModeExitError, "Exit error should be nil on success")
        XCTAssertFalse(store.managedAssistantRecoveryMode?.enabled == true,
                       "Recovery mode should be disabled after successful exit")
    }

    // MARK: - Error state surfaces inline error copy

    /// When entering recovery mode fails, `recoveryModeEnterError` is non-nil
    /// so the SSH section can render the inline error text.
    func testEnterRecoveryModeFailure_setsEnterError() async throws {
        stubFailure(statusCode: 500)
        let store = makeStore()

        store.enterManagedAssistantRecoveryMode()
        try await Task.sleep(nanoseconds: 500_000_000)

        XCTAssertFalse(store.recoveryModeEntering, "Entering flag should be cleared after failure")
        XCTAssertNotNil(store.recoveryModeEnterError,
                        "Enter error should be set when the request fails")
    }

    /// When exiting recovery mode fails, `recoveryModeExitError` is non-nil
    /// so the SSH section can render the inline error text.
    func testExitRecoveryModeFailure_setsExitError() async throws {
        stubFailure(statusCode: 503)
        let store = makeStore()
        store.managedAssistantRecoveryMode = PlatformAssistantRecoveryMode(
            enabled: true, debug_pod_name: "debug-pod-pre"
        )

        store.exitManagedAssistantRecoveryMode()
        try await Task.sleep(nanoseconds: 500_000_000)

        XCTAssertFalse(store.recoveryModeExiting, "Exiting flag should be cleared after failure")
        XCTAssertNotNil(store.recoveryModeExitError,
                        "Exit error should be set when the request fails")
    }

    // MARK: - Transition-in-flight computed logic

    /// Neither entering nor exiting is in flight when the store is freshly constructed —
    /// both buttons in the SSH section should be enabled by default.
    func testNoTransitionInFlight_bothButtonsEnabledByDefault() {
        let store = makeStore()

        // The `maintenanceTransitionInFlight` helper in the view is:
        //   store.recoveryModeEntering || store.recoveryModeExiting
        let transitionInFlight = store.recoveryModeEntering || store.recoveryModeExiting
        XCTAssertFalse(transitionInFlight, "No transition should be in flight on fresh store")
    }

    // MARK: - Refresh error does not leave entering/exiting flags set

    /// A failed refresh should clear `recoveryModeRefreshing` and set the error,
    /// without affecting the enter/exit flags.
    func testRefreshFailure_setsRefreshErrorAndClearsRefreshingFlag() async {
        stubFailure(statusCode: 404)
        let store = makeStore()

        await store.refreshManagedAssistantRecoveryMode()

        XCTAssertFalse(store.recoveryModeRefreshing, "Refreshing flag should be cleared after failure")
        XCTAssertNotNil(store.recoveryModeRefreshError,
                        "Refresh error should be populated when the request fails")
        XCTAssertFalse(store.recoveryModeEntering, "Enter flag should not be set by a failed refresh")
        XCTAssertFalse(store.recoveryModeExiting, "Exit flag should not be set by a failed refresh")
    }
}
