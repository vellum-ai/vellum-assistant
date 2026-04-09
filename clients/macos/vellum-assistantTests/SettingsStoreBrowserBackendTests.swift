import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

/// Verifies that `SettingsStore` emits the expected config patch payloads
/// for the `hostBrowser.cdpInspect` namespace and enforces loopback-only
/// host / in-range port validation before hitting the settings client.
@MainActor
final class SettingsStoreBrowserBackendTests: XCTestCase {

    private var mockSettingsClient: MockSettingsClient!
    private var store: SettingsStore!

    override func setUp() {
        super.setUp()
        mockSettingsClient = MockSettingsClient()
        mockSettingsClient.patchConfigResponse = true
        store = SettingsStore(settingsClient: mockSettingsClient)
    }

    override func tearDown() {
        store = nil
        mockSettingsClient = nil
        super.tearDown()
    }

    // MARK: - Helpers

    /// Returns the most recent `hostBrowser.cdpInspect` patch payload captured
    /// by the mock client, or `nil` if no such patch has been emitted.
    private func lastCdpInspectPatch() -> [String: Any]? {
        for payload in mockSettingsClient.patchConfigCalls.reversed() {
            if let hostBrowser = payload["hostBrowser"] as? [String: Any],
               let cdpInspect = hostBrowser["cdpInspect"] as? [String: Any] {
                return cdpInspect
            }
        }
        return nil
    }

    /// Waits for the background `Task` started by a store helper to flush
    /// its patch into the mock client. The helpers fire-and-forget a Task,
    /// so tests must poll until the captured call count matches expectations.
    private func waitForPatchCount(_ expected: Int, timeout: TimeInterval = 2.0) {
        let predicate = NSPredicate { _, _ in
            self.mockSettingsClient.patchConfigCalls.count >= expected
        }
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: nil)
        wait(for: [expectation], timeout: timeout)
    }

    // MARK: - Initial State

    func testInitialStateMatchesConfigDefaults() {
        XCTAssertFalse(store.hostBrowserCdpInspectEnabled)
        XCTAssertEqual(store.hostBrowserCdpInspectHost, "localhost")
        XCTAssertEqual(store.hostBrowserCdpInspectPort, 9222)
        XCTAssertEqual(store.hostBrowserCdpInspectProbeTimeoutMs, 500)
    }

    // MARK: - Toggle Enable/Disable

    func testSetEnabledTrueEmitsExpectedPatch() {
        store.setHostBrowserCdpInspectEnabled(true)

        waitForPatchCount(1)

        XCTAssertTrue(store.hostBrowserCdpInspectEnabled)
        let patch = lastCdpInspectPatch()
        XCTAssertNotNil(patch, "expected a hostBrowser.cdpInspect patch payload")
        XCTAssertEqual(patch?["enabled"] as? Bool, true)
        // Only `enabled` should be present — other fields are patched independently.
        XCTAssertNil(patch?["host"])
        XCTAssertNil(patch?["port"])
    }

    func testSetEnabledFalseEmitsExpectedPatch() {
        store.hostBrowserCdpInspectEnabled = true // start from enabled to force a toggle
        store.setHostBrowserCdpInspectEnabled(false)

        waitForPatchCount(1)

        XCTAssertFalse(store.hostBrowserCdpInspectEnabled)
        let patch = lastCdpInspectPatch()
        XCTAssertEqual(patch?["enabled"] as? Bool, false)
    }

    // MARK: - Host override

    func testSetValidLoopbackHostEmitsExpectedPatch() {
        let error = store.setHostBrowserCdpInspectHost("127.0.0.1")
        XCTAssertNil(error)
        XCTAssertEqual(store.hostBrowserCdpInspectHost, "127.0.0.1")

        waitForPatchCount(1)
        let patch = lastCdpInspectPatch()
        XCTAssertEqual(patch?["host"] as? String, "127.0.0.1")
        XCTAssertNil(patch?["enabled"])
        XCTAssertNil(patch?["port"])
    }

    func testSetValidLoopbackHostAcceptsEachAllowedVariant() {
        let allowed = ["localhost", "127.0.0.1", "::1", "[::1]"]
        for (index, value) in allowed.enumerated() {
            let error = store.setHostBrowserCdpInspectHost(value)
            XCTAssertNil(error, "\(value) should be accepted as a loopback host")
            waitForPatchCount(index + 1)
            XCTAssertEqual(store.hostBrowserCdpInspectHost, value)
        }
    }

    func testSetHostRejectsNonLoopbackValues() {
        let rejected = [
            "example.com",
            "192.168.1.10",
            "10.0.0.1",
            "0.0.0.0",
            "remote.internal",
        ]
        for value in rejected {
            let error = store.setHostBrowserCdpInspectHost(value)
            XCTAssertNotNil(error, "\(value) should be rejected as non-loopback")
        }
        // No patches should have been emitted for rejected hosts.
        XCTAssertTrue(mockSettingsClient.patchConfigCalls.isEmpty)
        XCTAssertEqual(store.hostBrowserCdpInspectHost, "localhost")
    }

    func testSetHostTrimsWhitespaceBeforeValidation() {
        let error = store.setHostBrowserCdpInspectHost("  127.0.0.1  ")
        XCTAssertNil(error)
        waitForPatchCount(1)

        XCTAssertEqual(store.hostBrowserCdpInspectHost, "127.0.0.1")
        let patch = lastCdpInspectPatch()
        XCTAssertEqual(patch?["host"] as? String, "127.0.0.1")
    }

    // MARK: - Port override

    func testSetValidPortEmitsExpectedPatch() {
        let error = store.setHostBrowserCdpInspectPort(9333)
        XCTAssertNil(error)
        XCTAssertEqual(store.hostBrowserCdpInspectPort, 9333)

        waitForPatchCount(1)
        let patch = lastCdpInspectPatch()
        XCTAssertEqual(patch?["port"] as? Int, 9333)
        XCTAssertNil(patch?["enabled"])
        XCTAssertNil(patch?["host"])
    }

    func testSetPortAcceptsBoundaries() {
        XCTAssertNil(store.setHostBrowserCdpInspectPort(1))
        waitForPatchCount(1)
        XCTAssertEqual(lastCdpInspectPatch()?["port"] as? Int, 1)

        XCTAssertNil(store.setHostBrowserCdpInspectPort(65535))
        waitForPatchCount(2)
        XCTAssertEqual(lastCdpInspectPatch()?["port"] as? Int, 65535)
    }

    func testSetPortRejectsOutOfRangeValues() {
        let rejected = [0, -1, 65536, 100_000]
        for value in rejected {
            let error = store.setHostBrowserCdpInspectPort(value)
            XCTAssertNotNil(error, "\(value) should be rejected as out-of-range")
        }
        XCTAssertTrue(mockSettingsClient.patchConfigCalls.isEmpty)
        XCTAssertEqual(store.hostBrowserCdpInspectPort, 9222)
    }

    // MARK: - Pure validation helpers

    func testIsValidHostBrowserCdpInspectHost() {
        XCTAssertTrue(SettingsStore.isValidHostBrowserCdpInspectHost("localhost"))
        XCTAssertTrue(SettingsStore.isValidHostBrowserCdpInspectHost("127.0.0.1"))
        XCTAssertTrue(SettingsStore.isValidHostBrowserCdpInspectHost("::1"))
        XCTAssertTrue(SettingsStore.isValidHostBrowserCdpInspectHost("[::1]"))
        XCTAssertTrue(SettingsStore.isValidHostBrowserCdpInspectHost("LOCALHOST"))
        XCTAssertTrue(SettingsStore.isValidHostBrowserCdpInspectHost("  localhost  "))

        XCTAssertFalse(SettingsStore.isValidHostBrowserCdpInspectHost(""))
        XCTAssertFalse(SettingsStore.isValidHostBrowserCdpInspectHost("example.com"))
        XCTAssertFalse(SettingsStore.isValidHostBrowserCdpInspectHost("192.168.0.1"))
        XCTAssertFalse(SettingsStore.isValidHostBrowserCdpInspectHost("0.0.0.0"))
    }

    func testIsValidHostBrowserCdpInspectPort() {
        XCTAssertTrue(SettingsStore.isValidHostBrowserCdpInspectPort(1))
        XCTAssertTrue(SettingsStore.isValidHostBrowserCdpInspectPort(9222))
        XCTAssertTrue(SettingsStore.isValidHostBrowserCdpInspectPort(65535))

        XCTAssertFalse(SettingsStore.isValidHostBrowserCdpInspectPort(0))
        XCTAssertFalse(SettingsStore.isValidHostBrowserCdpInspectPort(-1))
        XCTAssertFalse(SettingsStore.isValidHostBrowserCdpInspectPort(65536))
    }
}
