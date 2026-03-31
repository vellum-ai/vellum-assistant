import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

// MARK: - URLProtocol stub for maintenance-mode endpoint calls

private final class MaintenanceStoreURLProtocol: URLProtocol {
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

/// A URLProtocol stub that suspends the network response until `resume()` is called.
/// This lets tests mutate UserDefaults *between* the request being sent and the
/// response being delivered, exercising staleness-guard code paths.
private final class BlockingMaintenanceURLProtocol: URLProtocol {
    // The pending instance waiting to deliver its response.
    static var pendingInstance: BlockingMaintenanceURLProtocol?
    // The (response, data) to deliver when resume() is called.
    static var stagedResponse: (HTTPURLResponse, Data)?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        // Park ourselves so the test can call resume() after mutating UserDefaults.
        Self.pendingInstance = self
    }

    override func stopLoading() {
        Self.pendingInstance = nil
    }

    /// Deliver the staged response to the URLSession machinery.
    func resume() {
        guard let (response, data) = Self.stagedResponse else {
            client?.urlProtocol(self, didFailWithError: URLError(.unknown))
            return
        }
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
        Self.pendingInstance = nil
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
final class SettingsStoreManagedMaintenanceTests: XCTestCase {

    private let testAssistantId = "maintenance-test-asst-\(UUID().uuidString.prefix(8))"
    private let testOrgId = "org-test-\(UUID().uuidString.prefix(8))"

    /// Path to the primary lockfile at `~/.vellum.lock.json`.
    private var primaryLockfilePath: String {
        LockfilePaths.primaryPath
    }

    /// Backup of the lockfile contents before the test modifies it.
    private var lockfileBackup: Data?
    private var defaultsSuiteName: String!
    private var defaults: UserDefaults!
    private var previousToken: String?

    override func setUp() {
        super.setUp()

        // Backup the existing lockfile so we can restore it in tearDown.
        let primaryURL = URL(fileURLWithPath: primaryLockfilePath)
        lockfileBackup = try? Data(contentsOf: primaryURL)

        // Write a managed entry for our test assistant.
        let lockfileContent: [String: Any] = [
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

        // Isolated UserDefaults so we don't pollute the real app state.
        defaultsSuiteName = "SettingsStoreManagedMaintenanceTests.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: defaultsSuiteName)!
        defaults.removePersistentDomain(forName: defaultsSuiteName)
        defaults.set(testAssistantId, forKey: "connectedAssistantId")
        defaults.set(testOrgId, forKey: "connectedOrganizationId")

        // Register stub network handler and a session token.
        URLProtocol.registerClass(MaintenanceStoreURLProtocol.self)
        MaintenanceStoreURLProtocol.requestHandler = nil
        // Save any existing token so we can restore it in tearDown, preventing
        // the test run from destroying the developer's real session token.
        previousToken = SessionTokenManager.getToken()
        SessionTokenManager.setToken("stub-session-token")
    }

    override func tearDown() {
        URLProtocol.unregisterClass(MaintenanceStoreURLProtocol.self)
        MaintenanceStoreURLProtocol.requestHandler = nil
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

        defaults.removePersistentDomain(forName: defaultsSuiteName)
        defaults = nil
        defaultsSuiteName = nil

        super.tearDown()
    }

    // MARK: - Helpers

    private func makeStore() -> SettingsStore {
        // Pass in the isolated UserDefaults via the connectedAssistantId / connectedOrganizationId
        // that were already set in setUp(). SettingsStore reads from UserDefaults.standard, so we
        // mirror those values there for the duration of each test.
        UserDefaults.standard.set(testAssistantId, forKey: "connectedAssistantId")
        UserDefaults.standard.set(testOrgId, forKey: "connectedOrganizationId")
        return SettingsStore(settingsClient: MockSettingsClient())
    }

    private func cleanupStandard() {
        // Remove the test-specific values from standard UserDefaults.
        UserDefaults.standard.removeObject(forKey: "connectedAssistantId")
        UserDefaults.standard.removeObject(forKey: "connectedOrganizationId")
    }

    private func stubSuccess(
        id: String? = nil,
        maintenanceEnabled: Bool,
        debugPodName: String? = nil,
        enteredAt: String? = nil
    ) {
        let assistantId = id ?? testAssistantId
        MaintenanceStoreURLProtocol.requestHandler = { _ in
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
        MaintenanceStoreURLProtocol.requestHandler = { request in
            let url = request.url ?? URL(string: "https://example.com")!
            let response = HTTPURLResponse(
                url: url, statusCode: statusCode, httpVersion: nil, headerFields: nil
            )!
            return (response, Data("{\"detail\": \"error\"}".utf8))
        }
    }

    // MARK: - Initial state

    func testInitialMaintenanceModeStateIsNil() {
        defer { cleanupStandard() }
        let store = makeStore()

        XCTAssertNil(store.managedAssistantMaintenanceMode)
        XCTAssertFalse(store.maintenanceModeRefreshing)
        XCTAssertFalse(store.maintenanceModeEntering)
        XCTAssertFalse(store.maintenanceModeExiting)
        XCTAssertNil(store.maintenanceModeRefreshError)
        XCTAssertNil(store.maintenanceModeEnterError)
        XCTAssertNil(store.maintenanceModeExitError)
    }

    // MARK: - refreshManagedAssistantMaintenanceMode

    func testRefreshSetsMaintenanceModeEnabledFromSuccessResponse() async {
        defer { cleanupStandard() }
        stubSuccess(
            maintenanceEnabled: true,
            debugPodName: "debug-pod-abc",
            enteredAt: "2026-03-30T10:00:00Z"
        )

        let store = makeStore()
        await store.refreshManagedAssistantMaintenanceMode()

        let mode = try! XCTUnwrap(store.managedAssistantMaintenanceMode)
        XCTAssertTrue(mode.enabled)
        XCTAssertEqual(mode.debug_pod_name, "debug-pod-abc")
        XCTAssertEqual(mode.entered_at, "2026-03-30T10:00:00Z")
        XCTAssertNil(store.maintenanceModeRefreshError)
        XCTAssertFalse(store.maintenanceModeRefreshing)
    }

    func testRefreshSetsMaintenanceModeDisabled() async {
        defer { cleanupStandard() }
        stubSuccess(maintenanceEnabled: false)

        let store = makeStore()
        await store.refreshManagedAssistantMaintenanceMode()

        let mode = try! XCTUnwrap(store.managedAssistantMaintenanceMode)
        XCTAssertFalse(mode.enabled)
        XCTAssertNil(mode.debug_pod_name)
        XCTAssertNil(store.maintenanceModeRefreshError)
    }

    func testRefreshSetsErrorOnPlatformFailure() async {
        defer { cleanupStandard() }
        stubFailure(statusCode: 500)

        let store = makeStore()
        await store.refreshManagedAssistantMaintenanceMode()

        XCTAssertNil(store.managedAssistantMaintenanceMode)
        XCTAssertNotNil(store.maintenanceModeRefreshError)
        XCTAssertFalse(store.maintenanceModeRefreshing)
    }

    func testRefreshClearsRefreshErrorOnSuccess() async {
        defer { cleanupStandard() }

        let store = makeStore()

        // First call fails.
        stubFailure(statusCode: 503)
        await store.refreshManagedAssistantMaintenanceMode()
        XCTAssertNotNil(store.maintenanceModeRefreshError)

        // Second call succeeds — error should be cleared.
        stubSuccess(maintenanceEnabled: false)
        await store.refreshManagedAssistantMaintenanceMode()
        XCTAssertNil(store.maintenanceModeRefreshError)
    }

    func testRefreshIsNoOpWhenNoConnectedAssistantId() async {
        // Remove the connected assistant ID.
        UserDefaults.standard.removeObject(forKey: "connectedAssistantId")
        defer {
            UserDefaults.standard.removeObject(forKey: "connectedAssistantId")
            UserDefaults.standard.removeObject(forKey: "connectedOrganizationId")
        }

        // If refresh were to hit the network, the nil handler would cause an error.
        MaintenanceStoreURLProtocol.requestHandler = nil

        let store = SettingsStore(settingsClient: MockSettingsClient())
        await store.refreshManagedAssistantMaintenanceMode()

        XCTAssertNil(store.managedAssistantMaintenanceMode)
        XCTAssertNil(store.maintenanceModeRefreshError)
        XCTAssertFalse(store.maintenanceModeRefreshing)
    }

    // MARK: - enterManagedAssistantMaintenanceMode

    func testEnterMaintenanceModeUpdatesStateOnSuccess() async {
        defer { cleanupStandard() }
        stubSuccess(
            maintenanceEnabled: true,
            debugPodName: "debug-pod-enter",
            enteredAt: "2026-03-30T15:00:00Z"
        )

        let store = makeStore()
        store.enterManagedAssistantMaintenanceMode()

        let completed = expectation(description: "enter done")
        let task = Task {
            var ticks = 0
            while store.maintenanceModeEntering && ticks < 200 {
                await Task.yield()
                ticks += 1
            }
            completed.fulfill()
        }
        await fulfillment(of: [completed], timeout: 5)
        task.cancel()

        let mode = try! XCTUnwrap(store.managedAssistantMaintenanceMode)
        XCTAssertTrue(mode.enabled)
        XCTAssertEqual(mode.debug_pod_name, "debug-pod-enter")
        XCTAssertNil(store.maintenanceModeEnterError)
        XCTAssertFalse(store.maintenanceModeEntering)
    }

    func testEnterMaintenanceModeStoresErrorOnFailure() async {
        defer { cleanupStandard() }
        stubFailure(statusCode: 409)

        let store = makeStore()
        store.enterManagedAssistantMaintenanceMode()

        let completed = expectation(description: "enter done with error")
        let task = Task {
            var ticks = 0
            while store.maintenanceModeEntering && ticks < 200 {
                await Task.yield()
                ticks += 1
            }
            completed.fulfill()
        }
        await fulfillment(of: [completed], timeout: 5)
        task.cancel()

        XCTAssertNotNil(store.maintenanceModeEnterError)
        XCTAssertFalse(store.maintenanceModeEntering)
    }

    // MARK: - exitManagedAssistantMaintenanceMode

    func testExitMaintenanceModeUpdatesStateOnSuccess() async {
        defer { cleanupStandard() }
        stubSuccess(maintenanceEnabled: false)

        let store = makeStore()
        // Seed an active maintenance state.
        store.managedAssistantMaintenanceMode = PlatformAssistantMaintenanceMode(
            enabled: true,
            entered_at: "2026-03-30T10:00:00Z",
            debug_pod_name: "debug-pod-old"
        )

        store.exitManagedAssistantMaintenanceMode()

        let completed = expectation(description: "exit done")
        let task = Task {
            var ticks = 0
            while store.maintenanceModeExiting && ticks < 200 {
                await Task.yield()
                ticks += 1
            }
            completed.fulfill()
        }
        await fulfillment(of: [completed], timeout: 5)
        task.cancel()

        let mode = try! XCTUnwrap(store.managedAssistantMaintenanceMode)
        XCTAssertFalse(mode.enabled)
        XCTAssertNil(store.maintenanceModeExitError)
        XCTAssertFalse(store.maintenanceModeExiting)
    }

    func testExitMaintenanceModeStoresErrorOnFailure() async {
        defer { cleanupStandard() }
        stubFailure(statusCode: 409)

        let store = makeStore()
        store.exitManagedAssistantMaintenanceMode()

        let completed = expectation(description: "exit done with error")
        let task = Task {
            var ticks = 0
            while store.maintenanceModeExiting && ticks < 200 {
                await Task.yield()
                ticks += 1
            }
            completed.fulfill()
        }
        await fulfillment(of: [completed], timeout: 5)
        task.cancel()

        XCTAssertNotNil(store.maintenanceModeExitError)
        XCTAssertFalse(store.maintenanceModeExiting)
    }

    // MARK: - Error cleared on next action

    func testEnterClearsPreviousEnterError() async {
        defer { cleanupStandard() }

        let store = makeStore()

        // First call fails.
        stubFailure(statusCode: 500)
        store.enterManagedAssistantMaintenanceMode()
        let firstDone = expectation(description: "first enter done")
        let task1 = Task {
            var ticks = 0
            while store.maintenanceModeEntering && ticks < 200 {
                await Task.yield()
                ticks += 1
            }
            firstDone.fulfill()
        }
        await fulfillment(of: [firstDone], timeout: 5)
        task1.cancel()
        XCTAssertNotNil(store.maintenanceModeEnterError)

        // Second call succeeds — error should be cleared.
        stubSuccess(maintenanceEnabled: true)
        store.enterManagedAssistantMaintenanceMode()
        let secondDone = expectation(description: "second enter done")
        let task2 = Task {
            var ticks = 0
            while store.maintenanceModeEntering && ticks < 200 {
                await Task.yield()
                ticks += 1
            }
            secondDone.fulfill()
        }
        await fulfillment(of: [secondDone], timeout: 5)
        task2.cancel()
        XCTAssertNil(store.maintenanceModeEnterError)
    }

    func testExitClearsPreviousExitError() async {
        defer { cleanupStandard() }

        let store = makeStore()

        // First call fails.
        stubFailure(statusCode: 500)
        store.exitManagedAssistantMaintenanceMode()
        let firstDone = expectation(description: "first exit done")
        let task1 = Task {
            var ticks = 0
            while store.maintenanceModeExiting && ticks < 200 {
                await Task.yield()
                ticks += 1
            }
            firstDone.fulfill()
        }
        await fulfillment(of: [firstDone], timeout: 5)
        task1.cancel()
        XCTAssertNotNil(store.maintenanceModeExitError)

        // Second call succeeds — error should be cleared.
        stubSuccess(maintenanceEnabled: false)
        store.exitManagedAssistantMaintenanceMode()
        let secondDone = expectation(description: "second exit done")
        let task2 = Task {
            var ticks = 0
            while store.maintenanceModeExiting && ticks < 200 {
                await Task.yield()
                ticks += 1
            }
            secondDone.fulfill()
        }
        await fulfillment(of: [secondDone], timeout: 5)
        task2.cancel()
        XCTAssertNil(store.maintenanceModeExitError)
    }

    // MARK: - Staleness-guard regression tests

    /// Verifies that `refreshManagedAssistantMaintenanceMode` discards the response when
    /// `connectedAssistantId` changes while the request is in flight.
    func testRefreshDiscardsStaleResponseWhenAssistantIdChangesMidFlight() async {
        defer { cleanupStandard() }

        // Stage a success response for the blocking stub.
        let url = URL(string: "https://example.com")!
        let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil)!
        BlockingMaintenanceURLProtocol.stagedResponse = (
            response,
            assistantPayload(id: testAssistantId, maintenanceEnabled: true, debugPodName: "stale-pod")
        )
        BlockingMaintenanceURLProtocol.pendingInstance = nil

        // Swap the normal stub for the blocking variant.
        URLProtocol.unregisterClass(MaintenanceStoreURLProtocol.self)
        URLProtocol.registerClass(BlockingMaintenanceURLProtocol.self)
        defer {
            URLProtocol.unregisterClass(BlockingMaintenanceURLProtocol.self)
            URLProtocol.registerClass(MaintenanceStoreURLProtocol.self)
            BlockingMaintenanceURLProtocol.stagedResponse = nil
        }

        let store = makeStore()

        // Start the refresh in the background — it will block waiting for the stub to respond.
        let refreshTask = Task { @MainActor in
            await store.refreshManagedAssistantMaintenanceMode()
        }

        // Wait until the blocking stub has received the request (i.e. startLoading() was called).
        let requestReceived = expectation(description: "blocking stub received request")
        let waitTask = Task {
            var ticks = 0
            while BlockingMaintenanceURLProtocol.pendingInstance == nil && ticks < 500 {
                try? await Task.sleep(nanoseconds: 10_000_000) // 10 ms
                ticks += 1
            }
            requestReceived.fulfill()
        }
        await fulfillment(of: [requestReceived], timeout: 5)
        waitTask.cancel()

        // Simulate assistant switch mid-flight by changing UserDefaults.
        UserDefaults.standard.set("different-assistant-id", forKey: "connectedAssistantId")

        // Now unblock the response.
        BlockingMaintenanceURLProtocol.pendingInstance?.resume()

        // Wait for the refresh Task to complete.
        await refreshTask.value

        // Staleness guard should have discarded the response — mode must remain nil.
        XCTAssertNil(store.managedAssistantMaintenanceMode,
            "managedAssistantMaintenanceMode must not be updated with a stale response when connectedAssistantId changed mid-flight")
        XCTAssertFalse(store.maintenanceModeRefreshing)
    }

    /// Verifies that `refreshManagedAssistantMaintenanceMode` discards the response when
    /// `connectedOrganizationId` changes while the request is in flight.
    func testRefreshDiscardsStaleResponseWhenOrgIdChangesMidFlight() async {
        defer { cleanupStandard() }

        let url = URL(string: "https://example.com")!
        let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil)!
        BlockingMaintenanceURLProtocol.stagedResponse = (
            response,
            assistantPayload(id: testAssistantId, maintenanceEnabled: true, debugPodName: "stale-pod-org")
        )
        BlockingMaintenanceURLProtocol.pendingInstance = nil

        URLProtocol.unregisterClass(MaintenanceStoreURLProtocol.self)
        URLProtocol.registerClass(BlockingMaintenanceURLProtocol.self)
        defer {
            URLProtocol.unregisterClass(BlockingMaintenanceURLProtocol.self)
            URLProtocol.registerClass(MaintenanceStoreURLProtocol.self)
            BlockingMaintenanceURLProtocol.stagedResponse = nil
        }

        let store = makeStore()

        let refreshTask = Task { @MainActor in
            await store.refreshManagedAssistantMaintenanceMode()
        }

        let requestReceived = expectation(description: "blocking stub received request (org)")
        let waitTask = Task {
            var ticks = 0
            while BlockingMaintenanceURLProtocol.pendingInstance == nil && ticks < 500 {
                try? await Task.sleep(nanoseconds: 10_000_000)
                ticks += 1
            }
            requestReceived.fulfill()
        }
        await fulfillment(of: [requestReceived], timeout: 5)
        waitTask.cancel()

        // Simulate organization switch mid-flight.
        UserDefaults.standard.set("different-org-id", forKey: "connectedOrganizationId")

        BlockingMaintenanceURLProtocol.pendingInstance?.resume()

        await refreshTask.value

        XCTAssertNil(store.managedAssistantMaintenanceMode,
            "managedAssistantMaintenanceMode must not be updated with a stale response when connectedOrganizationId changed mid-flight")
        XCTAssertFalse(store.maintenanceModeRefreshing)
    }

    /// Verifies that `enterManagedAssistantMaintenanceMode` does not overwrite
    /// `managedAssistantMaintenanceMode` when `connectedAssistantId` changes mid-flight.
    func testEnterDiscardsStaleResponseWhenAssistantIdChangesMidFlight() async {
        defer { cleanupStandard() }

        let url = URL(string: "https://example.com")!
        let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil)!
        BlockingMaintenanceURLProtocol.stagedResponse = (
            response,
            assistantPayload(id: testAssistantId, maintenanceEnabled: true, debugPodName: "enter-stale-pod")
        )
        BlockingMaintenanceURLProtocol.pendingInstance = nil

        URLProtocol.unregisterClass(MaintenanceStoreURLProtocol.self)
        URLProtocol.registerClass(BlockingMaintenanceURLProtocol.self)
        defer {
            URLProtocol.unregisterClass(BlockingMaintenanceURLProtocol.self)
            URLProtocol.registerClass(MaintenanceStoreURLProtocol.self)
            BlockingMaintenanceURLProtocol.stagedResponse = nil
        }

        let store = makeStore()

        // Kick off enter — it fires a Task internally and returns immediately.
        store.enterManagedAssistantMaintenanceMode()

        // Wait for the stub to receive the in-flight request.
        let requestReceived = expectation(description: "enter: blocking stub received request")
        let waitTask = Task {
            var ticks = 0
            while BlockingMaintenanceURLProtocol.pendingInstance == nil && ticks < 500 {
                try? await Task.sleep(nanoseconds: 10_000_000)
                ticks += 1
            }
            requestReceived.fulfill()
        }
        await fulfillment(of: [requestReceived], timeout: 5)
        waitTask.cancel()

        // Simulate assistant switch mid-flight.
        UserDefaults.standard.set("different-assistant-id-enter", forKey: "connectedAssistantId")

        // Unblock the response.
        BlockingMaintenanceURLProtocol.pendingInstance?.resume()

        // Wait for the enter task to finish.
        let done = expectation(description: "enter finishes")
        let pollTask = Task {
            var ticks = 0
            while store.maintenanceModeEntering && ticks < 200 {
                await Task.yield()
                ticks += 1
            }
            done.fulfill()
        }
        await fulfillment(of: [done], timeout: 5)
        pollTask.cancel()

        // The staleness guard should discard the stale response.
        XCTAssertNil(store.managedAssistantMaintenanceMode,
            "managedAssistantMaintenanceMode must not be updated with a stale enter response when connectedAssistantId changed mid-flight")
        XCTAssertFalse(store.maintenanceModeEntering)
    }
}
