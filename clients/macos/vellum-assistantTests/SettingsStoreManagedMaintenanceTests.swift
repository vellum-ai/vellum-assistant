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
        SessionTokenManager.setToken("stub-session-token")
    }

    override func tearDown() {
        URLProtocol.unregisterClass(MaintenanceStoreURLProtocol.self)
        MaintenanceStoreURLProtocol.requestHandler = nil
        SessionTokenManager.deleteToken()

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
}
