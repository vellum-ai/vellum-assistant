import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

// MARK: - URLProtocol stub for recovery-mode endpoint calls

private final class RecoveryStoreURLProtocol: URLProtocol {
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

// MARK: - Blocking URLProtocol stub for mid-flight staleness tests

/// A URLProtocol stub that blocks the *first* POST request until `resume()` is called,
/// then responds immediately to any follow-up GET requests (e.g. the `refreshAssistant`
/// call that `enterRecoveryMode`/`exitRecoveryMode` makes after the POST succeeds).
/// This lets tests mutate UserDefaults *between* the POST being sent and the response
/// being delivered, exercising staleness-guard code paths.
private final class BlockingRecoveryURLProtocol: URLProtocol {
    // The pending instance waiting to deliver its response.
    static var pendingInstance: BlockingRecoveryURLProtocol?
    // The (response, data) to deliver when resume() is called.
    static var stagedResponse: (HTTPURLResponse, Data)?
    // True once the first blocking request has been resumed; subsequent requests respond immediately.
    static var hasResumed: Bool = false

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        // Only block the first request (the POST). After the first resume(), let follow-up
        // GET requests (from refreshAssistant) go through immediately so the staleness check
        // in SettingsStore can run without hanging.
        if Self.hasResumed {
            deliverStagedResponse()
        } else {
            // Park ourselves so the test can call resume() after mutating UserDefaults.
            Self.pendingInstance = self
        }
    }

    override func stopLoading() {
        Self.pendingInstance = nil
    }

    /// Deliver the staged response to the URLSession machinery.
    func resume() {
        Self.hasResumed = true
        deliverStagedResponse()
        Self.pendingInstance = nil
    }

    private func deliverStagedResponse() {
        guard let (response, data) = Self.stagedResponse else {
            client?.urlProtocol(self, didFailWithError: URLError(.unknown))
            return
        }
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }
}

// MARK: - Helpers

private func assistantPayload(
    id: String,
    maintenanceEnabled: Bool,
    debugPodName: String? = nil,
    enteredAt: String? = nil
) -> Data {
    let podField: String
    if let pod = debugPodName {
        podField = "\"debug_pod_name\": \"\(pod)\""
    } else {
        podField = "\"debug_pod_name\": null"
    }
    let atField: String
    if let at = enteredAt {
        atField = "\"entered_at\": \"\(at)\""
    } else {
        atField = "\"entered_at\": null"
    }
    return Data("""
    {
      "id": "\(id)",
      "name": "Test Managed Assistant",
      "status": "running",
      "maintenance_mode": {
        "enabled": \(maintenanceEnabled),
        \(podField),
        \(atField)
      }
    }
    """.utf8)
}

// MARK: - Tests

@MainActor
final class SettingsStoreManagedRecoveryTests: XCTestCase {

    private let testAssistantId = "maintenance-test-asst-\(UUID().uuidString.prefix(8))"
    private let testOrgId = "org-test-\(UUID().uuidString.prefix(8))"

    /// Path to the primary lockfile at `~/.vellum.lock.json`.
    private var primaryLockfilePath: String {
        LockfilePaths.primaryPath
    }

    /// Backup of the lockfile contents before the test modifies it.
    private var lockfileBackup: Data?
    private var previousToken: String?

    override func setUp() {
        super.setUp()

        // Backup the existing lockfile so we can restore it in tearDown.
        let primaryURL = URL(fileURLWithPath: primaryLockfilePath)
        lockfileBackup = try? Data(contentsOf: primaryURL)

        // Write a managed entry for our test assistant.
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

        // Register stub network handler and a session token.
        URLProtocol.registerClass(RecoveryStoreURLProtocol.self)
        RecoveryStoreURLProtocol.requestHandler = nil
        // Save any existing token so we can restore it in tearDown, preventing
        // the test run from destroying the developer's real session token.
        previousToken = SessionTokenManager.getToken()
        SessionTokenManager.setToken("stub-session-token")
    }

    override func tearDown() {
        URLProtocol.unregisterClass(RecoveryStoreURLProtocol.self)
        RecoveryStoreURLProtocol.requestHandler = nil
        if let token = previousToken {
            SessionTokenManager.setToken(token)
        } else {
            SessionTokenManager.deleteToken()
        }
        previousToken = nil

        // Restore the original lockfile (or delete it if there was nothing before).
        let primaryURL = URL(fileURLWithPath: primaryLockfilePath)
        if let backup = lockfileBackup {
            try? backup.write(to: primaryURL, options: .atomic)
        } else {
            try? FileManager.default.removeItem(at: primaryURL)
        }
        lockfileBackup = nil

        // Unconditionally clean up any test-specific values written to UserDefaults.standard
        // by makeStore() so they don't leak into subsequent tests.
        UserDefaults.standard.removeObject(forKey: "connectedOrganizationId")

        super.tearDown()
    }

    // MARK: - Helpers

    private func makeStore() -> SettingsStore {
        // SettingsStore reads activeAssistant from the lockfile (already set in setUp)
        // and connectedOrganizationId from UserDefaults.standard.
        UserDefaults.standard.set(testOrgId, forKey: "connectedOrganizationId")
        return SettingsStore(settingsClient: MockSettingsClient())
    }

    private func stubSuccess(
        id: String? = nil,
        maintenanceEnabled: Bool,
        debugPodName: String? = nil,
        enteredAt: String? = nil
    ) {
        let assistantId = id ?? testAssistantId
        RecoveryStoreURLProtocol.requestHandler = { _ in
            let url = URL(string: "https://example.com")!
            let response = HTTPURLResponse(
                url: url, statusCode: 200, httpVersion: nil, headerFields: nil
            )!
            return (response, assistantPayload(
                id: assistantId,
                maintenanceEnabled: maintenanceEnabled,
                debugPodName: debugPodName,
                enteredAt: enteredAt
            ))
        }
    }

    private func stubFailure(statusCode: Int) {
        RecoveryStoreURLProtocol.requestHandler = { request in
            let url = request.url ?? URL(string: "https://example.com")!
            let response = HTTPURLResponse(
                url: url, statusCode: statusCode, httpVersion: nil, headerFields: nil
            )!
            return (response, Data("{\"detail\": \"error\"}".utf8))
        }
    }

    // MARK: - Initial state

    func testInitialRecoveryModeStateIsNil() {
        let store = makeStore()

        XCTAssertNil(store.managedAssistantRecoveryMode)
        XCTAssertFalse(store.recoveryModeRefreshing)
        XCTAssertFalse(store.recoveryModeEntering)
        XCTAssertFalse(store.recoveryModeExiting)
        XCTAssertNil(store.recoveryModeRefreshError)
        XCTAssertNil(store.recoveryModeEnterError)
        XCTAssertNil(store.recoveryModeExitError)
    }

    // MARK: - refreshManagedAssistantRecoveryMode

    func testRefreshSetsRecoveryModeEnabledFromSuccessResponse() async {
        stubSuccess(
            maintenanceEnabled: true,
            debugPodName: "debug-pod-abc",
            enteredAt: "2026-03-30T10:00:00Z"
        )

        let store = makeStore()
        await store.refreshManagedAssistantRecoveryMode()

        let mode = try! XCTUnwrap(store.managedAssistantRecoveryMode)
        XCTAssertTrue(mode.enabled)
        XCTAssertEqual(mode.debug_pod_name, "debug-pod-abc")
        XCTAssertEqual(mode.entered_at, "2026-03-30T10:00:00Z")
        XCTAssertNil(store.recoveryModeRefreshError)
        XCTAssertFalse(store.recoveryModeRefreshing)
    }

    func testRefreshSetsRecoveryModeDisabled() async {
        stubSuccess(maintenanceEnabled: false)

        let store = makeStore()
        await store.refreshManagedAssistantRecoveryMode()

        let mode = try! XCTUnwrap(store.managedAssistantRecoveryMode)
        XCTAssertFalse(mode.enabled)
        XCTAssertNil(mode.debug_pod_name)
        XCTAssertNil(store.recoveryModeRefreshError)
    }

    func testRefreshSetsErrorOnPlatformFailure() async {
        stubFailure(statusCode: 500)

        let store = makeStore()
        await store.refreshManagedAssistantRecoveryMode()

        XCTAssertNil(store.managedAssistantRecoveryMode)
        XCTAssertNotNil(store.recoveryModeRefreshError)
        XCTAssertFalse(store.recoveryModeRefreshing)
    }

    func testRefreshClearsRefreshErrorOnSuccess() async {

        let store = makeStore()

        // First call fails.
        stubFailure(statusCode: 503)
        await store.refreshManagedAssistantRecoveryMode()
        XCTAssertNotNil(store.recoveryModeRefreshError)

        // Second call succeeds — error should be cleared.
        stubSuccess(maintenanceEnabled: false)
        await store.refreshManagedAssistantRecoveryMode()
        XCTAssertNil(store.recoveryModeRefreshError)
    }

    func testRefreshIsNoOpWhenNoConnectedAssistantId() async {
        // Clear the active assistant to exercise the no-op path.
        // tearDown restores the original lockfile.
        LockfileAssistant.setActiveAssistantId(nil)

        // If refresh were to hit the network, the nil handler would cause an error.
        RecoveryStoreURLProtocol.requestHandler = nil

        let store = SettingsStore(settingsClient: MockSettingsClient())
        await store.refreshManagedAssistantRecoveryMode()

        XCTAssertNil(store.managedAssistantRecoveryMode)
        XCTAssertNil(store.recoveryModeRefreshError)
        XCTAssertFalse(store.recoveryModeRefreshing)
    }

    // MARK: - enterManagedAssistantRecoveryMode

    func testEnterRecoveryModeUpdatesStateOnSuccess() async {
        stubSuccess(
            maintenanceEnabled: true,
            debugPodName: "debug-pod-enter",
            enteredAt: "2026-03-30T15:00:00Z"
        )

        let store = makeStore()
        store.enterManagedAssistantRecoveryMode()

        let completed = expectation(description: "enter done")
        let task = Task {
            var ticks = 0
            while store.recoveryModeEntering && ticks < 200 {
                await Task.yield()
                ticks += 1
            }
            completed.fulfill()
        }
        await fulfillment(of: [completed], timeout: 5)
        task.cancel()

        let mode = try! XCTUnwrap(store.managedAssistantRecoveryMode)
        XCTAssertTrue(mode.enabled)
        XCTAssertEqual(mode.debug_pod_name, "debug-pod-enter")
        XCTAssertNil(store.recoveryModeEnterError)
        XCTAssertFalse(store.recoveryModeEntering)
    }

    func testEnterRecoveryModeStoresErrorOnFailure() async {
        stubFailure(statusCode: 409)

        let store = makeStore()
        store.enterManagedAssistantRecoveryMode()

        let completed = expectation(description: "enter done with error")
        let task = Task {
            var ticks = 0
            while store.recoveryModeEntering && ticks < 200 {
                await Task.yield()
                ticks += 1
            }
            completed.fulfill()
        }
        await fulfillment(of: [completed], timeout: 5)
        task.cancel()

        XCTAssertNotNil(store.recoveryModeEnterError)
        XCTAssertFalse(store.recoveryModeEntering)
    }

    // MARK: - exitManagedAssistantRecoveryMode

    func testExitRecoveryModeUpdatesStateOnSuccess() async {
        stubSuccess(maintenanceEnabled: false)

        let store = makeStore()
        // Seed an active maintenance state.
        store.managedAssistantRecoveryMode = PlatformAssistantRecoveryMode(
            enabled: true,
            entered_at: "2026-03-30T10:00:00Z",
            debug_pod_name: "debug-pod-old"
        )

        store.exitManagedAssistantRecoveryMode()

        let completed = expectation(description: "exit done")
        let task = Task {
            var ticks = 0
            while store.recoveryModeExiting && ticks < 200 {
                await Task.yield()
                ticks += 1
            }
            completed.fulfill()
        }
        await fulfillment(of: [completed], timeout: 5)
        task.cancel()

        let mode = try! XCTUnwrap(store.managedAssistantRecoveryMode)
        XCTAssertFalse(mode.enabled)
        XCTAssertNil(store.recoveryModeExitError)
        XCTAssertFalse(store.recoveryModeExiting)
    }

    func testExitRecoveryModeStoresErrorOnFailure() async {
        stubFailure(statusCode: 409)

        let store = makeStore()
        store.exitManagedAssistantRecoveryMode()

        let completed = expectation(description: "exit done with error")
        let task = Task {
            var ticks = 0
            while store.recoveryModeExiting && ticks < 200 {
                await Task.yield()
                ticks += 1
            }
            completed.fulfill()
        }
        await fulfillment(of: [completed], timeout: 5)
        task.cancel()

        XCTAssertNotNil(store.recoveryModeExitError)
        XCTAssertFalse(store.recoveryModeExiting)
    }

    // MARK: - Error cleared on next action

    func testEnterClearsPreviousEnterError() async {

        let store = makeStore()

        // First call fails.
        stubFailure(statusCode: 500)
        store.enterManagedAssistantRecoveryMode()
        let firstDone = expectation(description: "first enter done")
        let task1 = Task {
            var ticks = 0
            while store.recoveryModeEntering && ticks < 200 {
                await Task.yield()
                ticks += 1
            }
            firstDone.fulfill()
        }
        await fulfillment(of: [firstDone], timeout: 5)
        task1.cancel()
        XCTAssertNotNil(store.recoveryModeEnterError)

        // Second call succeeds — error should be cleared.
        stubSuccess(maintenanceEnabled: true)
        store.enterManagedAssistantRecoveryMode()
        let secondDone = expectation(description: "second enter done")
        let task2 = Task {
            var ticks = 0
            while store.recoveryModeEntering && ticks < 200 {
                await Task.yield()
                ticks += 1
            }
            secondDone.fulfill()
        }
        await fulfillment(of: [secondDone], timeout: 5)
        task2.cancel()
        XCTAssertNil(store.recoveryModeEnterError)
    }

    func testExitClearsPreviousExitError() async {

        let store = makeStore()

        // First call fails.
        stubFailure(statusCode: 500)
        store.exitManagedAssistantRecoveryMode()
        let firstDone = expectation(description: "first exit done")
        let task1 = Task {
            var ticks = 0
            while store.recoveryModeExiting && ticks < 200 {
                await Task.yield()
                ticks += 1
            }
            firstDone.fulfill()
        }
        await fulfillment(of: [firstDone], timeout: 5)
        task1.cancel()
        XCTAssertNotNil(store.recoveryModeExitError)

        // Second call succeeds — error should be cleared.
        stubSuccess(maintenanceEnabled: false)
        store.exitManagedAssistantRecoveryMode()
        let secondDone = expectation(description: "second exit done")
        let task2 = Task {
            var ticks = 0
            while store.recoveryModeExiting && ticks < 200 {
                await Task.yield()
                ticks += 1
            }
            secondDone.fulfill()
        }
        await fulfillment(of: [secondDone], timeout: 5)
        task2.cancel()
        XCTAssertNil(store.recoveryModeExitError)
    }

    // MARK: - Staleness-guard regression tests

    /// Verifies that `refreshManagedAssistantRecoveryMode` discards the response when
    /// `connectedAssistantId` changes while the request is in flight.
    func testRefreshDiscardsStaleResponseWhenAssistantIdChangesMidFlight() async {

        // Stage a success response for the blocking stub.
        let url = URL(string: "https://example.com")!
        let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil)!
        BlockingRecoveryURLProtocol.stagedResponse = (
            response,
            assistantPayload(id: testAssistantId, maintenanceEnabled: true, debugPodName: "stale-pod")
        )
        BlockingRecoveryURLProtocol.pendingInstance = nil

        // Swap the normal stub for the blocking variant.
        URLProtocol.unregisterClass(RecoveryStoreURLProtocol.self)
        URLProtocol.registerClass(BlockingRecoveryURLProtocol.self)
        defer {
            URLProtocol.unregisterClass(BlockingRecoveryURLProtocol.self)
            URLProtocol.registerClass(RecoveryStoreURLProtocol.self)
            BlockingRecoveryURLProtocol.stagedResponse = nil
            BlockingRecoveryURLProtocol.hasResumed = false
        }

        let store = makeStore()

        // Start the refresh in the background — it will block waiting for the stub to respond.
        let refreshTask = Task { @MainActor in
            await store.refreshManagedAssistantRecoveryMode()
        }

        // Wait until the blocking stub has received the request (i.e. startLoading() was called).
        let requestReceived = expectation(description: "blocking stub received request")
        let waitTask = Task {
            var ticks = 0
            while BlockingRecoveryURLProtocol.pendingInstance == nil && ticks < 500 {
                try? await Task.sleep(nanoseconds: 10_000_000) // 10 ms
                ticks += 1
            }
            requestReceived.fulfill()
        }
        await fulfillment(of: [requestReceived], timeout: 5)
        waitTask.cancel()

        // Simulate assistant switch mid-flight by changing the lockfile.
        LockfileAssistant.setActiveAssistantId("different-assistant-id")

        // Now unblock the response.
        BlockingRecoveryURLProtocol.pendingInstance?.resume()

        // Wait for the refresh Task to complete.
        await refreshTask.value

        // Staleness guard should have discarded the response — mode must remain nil.
        XCTAssertNil(store.managedAssistantRecoveryMode,
            "managedAssistantRecoveryMode must not be updated with a stale response when connectedAssistantId changed mid-flight")
        XCTAssertFalse(store.recoveryModeRefreshing)
    }

    /// Verifies that `refreshManagedAssistantRecoveryMode` discards the response when
    /// `connectedOrganizationId` changes while the request is in flight.
    func testRefreshDiscardsStaleResponseWhenOrgIdChangesMidFlight() async {

        let url = URL(string: "https://example.com")!
        let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil)!
        BlockingRecoveryURLProtocol.stagedResponse = (
            response,
            assistantPayload(id: testAssistantId, maintenanceEnabled: true, debugPodName: "stale-pod-org")
        )
        BlockingRecoveryURLProtocol.pendingInstance = nil

        URLProtocol.unregisterClass(RecoveryStoreURLProtocol.self)
        URLProtocol.registerClass(BlockingRecoveryURLProtocol.self)
        defer {
            URLProtocol.unregisterClass(BlockingRecoveryURLProtocol.self)
            URLProtocol.registerClass(RecoveryStoreURLProtocol.self)
            BlockingRecoveryURLProtocol.stagedResponse = nil
            BlockingRecoveryURLProtocol.hasResumed = false
        }

        let store = makeStore()

        let refreshTask = Task { @MainActor in
            await store.refreshManagedAssistantRecoveryMode()
        }

        let requestReceived = expectation(description: "blocking stub received request (org)")
        let waitTask = Task {
            var ticks = 0
            while BlockingRecoveryURLProtocol.pendingInstance == nil && ticks < 500 {
                try? await Task.sleep(nanoseconds: 10_000_000)
                ticks += 1
            }
            requestReceived.fulfill()
        }
        await fulfillment(of: [requestReceived], timeout: 5)
        waitTask.cancel()

        // Simulate organization switch mid-flight.
        UserDefaults.standard.set("different-org-id", forKey: "connectedOrganizationId")

        BlockingRecoveryURLProtocol.pendingInstance?.resume()

        await refreshTask.value

        XCTAssertNil(store.managedAssistantRecoveryMode,
            "managedAssistantRecoveryMode must not be updated with a stale response when connectedOrganizationId changed mid-flight")
        XCTAssertFalse(store.recoveryModeRefreshing)
    }

    /// Verifies that `enterManagedAssistantRecoveryMode` does not overwrite
    /// `managedAssistantRecoveryMode` when `connectedAssistantId` changes mid-flight.
    func testEnterDiscardsStaleResponseWhenAssistantIdChangesMidFlight() async {

        let url = URL(string: "https://example.com")!
        let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil)!
        BlockingRecoveryURLProtocol.stagedResponse = (
            response,
            assistantPayload(id: testAssistantId, maintenanceEnabled: true, debugPodName: "enter-stale-pod")
        )
        BlockingRecoveryURLProtocol.pendingInstance = nil

        URLProtocol.unregisterClass(RecoveryStoreURLProtocol.self)
        URLProtocol.registerClass(BlockingRecoveryURLProtocol.self)
        defer {
            URLProtocol.unregisterClass(BlockingRecoveryURLProtocol.self)
            URLProtocol.registerClass(RecoveryStoreURLProtocol.self)
            BlockingRecoveryURLProtocol.stagedResponse = nil
            BlockingRecoveryURLProtocol.hasResumed = false
        }

        let store = makeStore()

        // Kick off enter — it fires a Task internally and returns immediately.
        store.enterManagedAssistantRecoveryMode()

        // Wait for the stub to receive the in-flight request.
        let requestReceived = expectation(description: "enter: blocking stub received request")
        let waitTask = Task {
            var ticks = 0
            while BlockingRecoveryURLProtocol.pendingInstance == nil && ticks < 500 {
                try? await Task.sleep(nanoseconds: 10_000_000)
                ticks += 1
            }
            requestReceived.fulfill()
        }
        await fulfillment(of: [requestReceived], timeout: 5)
        waitTask.cancel()

        // Simulate assistant switch mid-flight.
        LockfileAssistant.setActiveAssistantId("different-assistant-id-enter")

        // Unblock the response.
        BlockingRecoveryURLProtocol.pendingInstance?.resume()

        // Wait for the enter task to finish.
        let done = expectation(description: "enter finishes")
        let pollTask = Task {
            var ticks = 0
            while store.recoveryModeEntering && ticks < 200 {
                await Task.yield()
                ticks += 1
            }
            done.fulfill()
        }
        await fulfillment(of: [done], timeout: 5)
        pollTask.cancel()

        // The staleness guard should discard the stale response.
        XCTAssertNil(store.managedAssistantRecoveryMode,
            "managedAssistantRecoveryMode must not be updated with a stale enter response when connectedAssistantId changed mid-flight")
        XCTAssertFalse(store.recoveryModeEntering)
    }

    /// Verifies that `enterManagedAssistantRecoveryMode` does not overwrite
    /// `managedAssistantRecoveryMode` when `connectedOrganizationId` changes mid-flight.
    func testEnterDiscardsStaleResponseWhenOrgIdChangesMidFlight() async {

        let url = URL(string: "https://example.com")!
        let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil)!
        BlockingRecoveryURLProtocol.stagedResponse = (
            response,
            assistantPayload(id: testAssistantId, maintenanceEnabled: true, debugPodName: "enter-stale-pod-org")
        )
        BlockingRecoveryURLProtocol.pendingInstance = nil

        URLProtocol.unregisterClass(RecoveryStoreURLProtocol.self)
        URLProtocol.registerClass(BlockingRecoveryURLProtocol.self)
        defer {
            URLProtocol.unregisterClass(BlockingRecoveryURLProtocol.self)
            URLProtocol.registerClass(RecoveryStoreURLProtocol.self)
            BlockingRecoveryURLProtocol.stagedResponse = nil
            BlockingRecoveryURLProtocol.hasResumed = false
        }

        let store = makeStore()

        // Kick off enter — it fires a Task internally and returns immediately.
        store.enterManagedAssistantRecoveryMode()

        // Wait for the stub to receive the in-flight request.
        let requestReceived = expectation(description: "enter org: blocking stub received request")
        let waitTask = Task {
            var ticks = 0
            while BlockingRecoveryURLProtocol.pendingInstance == nil && ticks < 500 {
                try? await Task.sleep(nanoseconds: 10_000_000)
                ticks += 1
            }
            requestReceived.fulfill()
        }
        await fulfillment(of: [requestReceived], timeout: 5)
        waitTask.cancel()

        // Simulate organization switch mid-flight.
        UserDefaults.standard.set("different-org-id-enter", forKey: "connectedOrganizationId")

        // Unblock the response.
        BlockingRecoveryURLProtocol.pendingInstance?.resume()

        // Wait for the enter task to finish.
        let done = expectation(description: "enter org finishes")
        let pollTask = Task {
            var ticks = 0
            while store.recoveryModeEntering && ticks < 200 {
                await Task.yield()
                ticks += 1
            }
            done.fulfill()
        }
        await fulfillment(of: [done], timeout: 5)
        pollTask.cancel()

        // The staleness guard should discard the stale response.
        XCTAssertNil(store.managedAssistantRecoveryMode,
            "managedAssistantRecoveryMode must not be updated with a stale enter response when connectedOrganizationId changed mid-flight")
        XCTAssertFalse(store.recoveryModeEntering)
    }

    /// Verifies that `exitManagedAssistantRecoveryMode` does not overwrite
    /// `managedAssistantRecoveryMode` when `connectedAssistantId` changes mid-flight.
    func testExitDiscardsStaleResponseWhenAssistantIdChangesMidFlight() async {

        let url = URL(string: "https://example.com")!
        let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil)!
        BlockingRecoveryURLProtocol.stagedResponse = (
            response,
            assistantPayload(id: testAssistantId, maintenanceEnabled: false)
        )
        BlockingRecoveryURLProtocol.pendingInstance = nil

        URLProtocol.unregisterClass(RecoveryStoreURLProtocol.self)
        URLProtocol.registerClass(BlockingRecoveryURLProtocol.self)
        defer {
            URLProtocol.unregisterClass(BlockingRecoveryURLProtocol.self)
            URLProtocol.registerClass(RecoveryStoreURLProtocol.self)
            BlockingRecoveryURLProtocol.stagedResponse = nil
            BlockingRecoveryURLProtocol.hasResumed = false
        }

        let store = makeStore()
        // Seed an active maintenance state so exit has something to clear.
        store.managedAssistantRecoveryMode = PlatformAssistantRecoveryMode(
            enabled: true,
            entered_at: "2026-03-30T10:00:00Z",
            debug_pod_name: "exit-stale-pod"
        )

        // Kick off exit — it fires a Task internally and returns immediately.
        store.exitManagedAssistantRecoveryMode()

        // Wait for the stub to receive the in-flight request.
        let requestReceived = expectation(description: "exit: blocking stub received request")
        let waitTask = Task {
            var ticks = 0
            while BlockingRecoveryURLProtocol.pendingInstance == nil && ticks < 500 {
                try? await Task.sleep(nanoseconds: 10_000_000)
                ticks += 1
            }
            requestReceived.fulfill()
        }
        await fulfillment(of: [requestReceived], timeout: 5)
        waitTask.cancel()

        // Simulate assistant switch mid-flight.
        LockfileAssistant.setActiveAssistantId("different-assistant-id-exit")

        // Unblock the response.
        BlockingRecoveryURLProtocol.pendingInstance?.resume()

        // Wait for the exit task to finish.
        let done = expectation(description: "exit finishes")
        let pollTask = Task {
            var ticks = 0
            while store.recoveryModeExiting && ticks < 200 {
                await Task.yield()
                ticks += 1
            }
            done.fulfill()
        }
        await fulfillment(of: [done], timeout: 5)
        pollTask.cancel()

        // The staleness guard should discard the stale response — seeded state must be preserved.
        let mode = try! XCTUnwrap(store.managedAssistantRecoveryMode,
            "managedAssistantRecoveryMode must not be cleared by a stale exit response when connectedAssistantId changed mid-flight")
        XCTAssertTrue(mode.enabled,
            "The seeded enabled=true state should be preserved, not overwritten by the stale response")
        XCTAssertFalse(store.recoveryModeExiting)
    }

    /// Verifies that `exitManagedAssistantRecoveryMode` does not overwrite
    /// `managedAssistantRecoveryMode` when `connectedOrganizationId` changes mid-flight.
    func testExitDiscardsStaleResponseWhenOrgIdChangesMidFlight() async {

        let url = URL(string: "https://example.com")!
        let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil)!
        BlockingRecoveryURLProtocol.stagedResponse = (
            response,
            assistantPayload(id: testAssistantId, maintenanceEnabled: false)
        )
        BlockingRecoveryURLProtocol.pendingInstance = nil

        URLProtocol.unregisterClass(RecoveryStoreURLProtocol.self)
        URLProtocol.registerClass(BlockingRecoveryURLProtocol.self)
        defer {
            URLProtocol.unregisterClass(BlockingRecoveryURLProtocol.self)
            URLProtocol.registerClass(RecoveryStoreURLProtocol.self)
            BlockingRecoveryURLProtocol.stagedResponse = nil
            BlockingRecoveryURLProtocol.hasResumed = false
        }

        let store = makeStore()
        // Seed an active maintenance state so exit has something to clear.
        store.managedAssistantRecoveryMode = PlatformAssistantRecoveryMode(
            enabled: true,
            entered_at: "2026-03-30T10:00:00Z",
            debug_pod_name: "exit-stale-pod-org"
        )

        // Kick off exit — it fires a Task internally and returns immediately.
        store.exitManagedAssistantRecoveryMode()

        // Wait for the stub to receive the in-flight request.
        let requestReceived = expectation(description: "exit org: blocking stub received request")
        let waitTask = Task {
            var ticks = 0
            while BlockingRecoveryURLProtocol.pendingInstance == nil && ticks < 500 {
                try? await Task.sleep(nanoseconds: 10_000_000)
                ticks += 1
            }
            requestReceived.fulfill()
        }
        await fulfillment(of: [requestReceived], timeout: 5)
        waitTask.cancel()

        // Simulate organization switch mid-flight.
        UserDefaults.standard.set("different-org-id-exit", forKey: "connectedOrganizationId")

        // Unblock the response.
        BlockingRecoveryURLProtocol.pendingInstance?.resume()

        // Wait for the exit task to finish.
        let done = expectation(description: "exit org finishes")
        let pollTask = Task {
            var ticks = 0
            while store.recoveryModeExiting && ticks < 200 {
                await Task.yield()
                ticks += 1
            }
            done.fulfill()
        }
        await fulfillment(of: [done], timeout: 5)
        pollTask.cancel()

        // The staleness guard should discard the stale response — seeded state must be preserved.
        let mode = try! XCTUnwrap(store.managedAssistantRecoveryMode,
            "managedAssistantRecoveryMode must not be cleared by a stale exit response when connectedOrganizationId changed mid-flight")
        XCTAssertTrue(mode.enabled,
            "The seeded enabled=true state should be preserved, not overwritten by the stale response")
        XCTAssertFalse(store.recoveryModeExiting)
    }
}
