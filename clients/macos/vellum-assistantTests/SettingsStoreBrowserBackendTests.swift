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

    // MARK: - applyHostBrowserCdpInspectConfig

    func testApplyDaemonConfigAcceptsValidValues() {
        // Reset to known-distinct values so we can verify the apply path
        // overwrites them with the config payload.
        store.hostBrowserCdpInspectEnabled = false
        store.hostBrowserCdpInspectHost = "localhost"
        store.hostBrowserCdpInspectPort = 9222

        let config: [String: Any] = [
            "hostBrowser": [
                "cdpInspect": [
                    "enabled": true,
                    "host": "127.0.0.1",
                    "port": 9333,
                    "probeTimeoutMs": 750,
                ]
            ]
        ]
        SettingsStore.applyHostBrowserCdpInspectConfig(config, into: store)

        XCTAssertTrue(store.hostBrowserCdpInspectEnabled)
        XCTAssertEqual(store.hostBrowserCdpInspectHost, "127.0.0.1")
        XCTAssertEqual(store.hostBrowserCdpInspectPort, 9333)
        XCTAssertEqual(store.hostBrowserCdpInspectProbeTimeoutMs, 750)
    }

    func testApplyDaemonConfigRejectsNonLoopbackHost() {
        // Pre-seed with a valid non-default value so we can distinguish
        // "left untouched" from "reset to default" in the assertion.
        store.hostBrowserCdpInspectHost = "127.0.0.1"

        let config: [String: Any] = [
            "hostBrowser": [
                "cdpInspect": [
                    "host": "attacker.example.com",
                ]
            ]
        ]
        SettingsStore.applyHostBrowserCdpInspectConfig(config, into: store)

        // Invalid host should fall back to the default, NOT persist
        // "attacker.example.com" and NOT silently leave the old value.
        XCTAssertEqual(store.hostBrowserCdpInspectHost, SettingsStore.defaultHostBrowserCdpInspectHost)
        XCTAssertEqual(store.hostBrowserCdpInspectHost, "localhost")
    }

    func testApplyDaemonConfigRejectsPublicIPHost() {
        store.hostBrowserCdpInspectHost = "127.0.0.1"
        let config: [String: Any] = [
            "hostBrowser": [
                "cdpInspect": [
                    "host": "192.168.1.10",
                ]
            ]
        ]
        SettingsStore.applyHostBrowserCdpInspectConfig(config, into: store)
        XCTAssertEqual(store.hostBrowserCdpInspectHost, "localhost")
    }

    func testApplyDaemonConfigRejectsOutOfRangePort() {
        store.hostBrowserCdpInspectPort = 9333

        let config: [String: Any] = [
            "hostBrowser": [
                "cdpInspect": [
                    "port": 70000,
                ]
            ]
        ]
        SettingsStore.applyHostBrowserCdpInspectConfig(config, into: store)

        // Out-of-range port should fall back to the default.
        XCTAssertEqual(store.hostBrowserCdpInspectPort, SettingsStore.defaultHostBrowserCdpInspectPort)
        XCTAssertEqual(store.hostBrowserCdpInspectPort, 9222)
    }

    func testApplyDaemonConfigRejectsZeroPort() {
        store.hostBrowserCdpInspectPort = 9333
        let config: [String: Any] = [
            "hostBrowser": [
                "cdpInspect": [
                    "port": 0,
                ]
            ]
        ]
        SettingsStore.applyHostBrowserCdpInspectConfig(config, into: store)
        XCTAssertEqual(store.hostBrowserCdpInspectPort, 9222)
    }

    func testApplyDaemonConfigRejectsOutOfRangePortFromDouble() {
        store.hostBrowserCdpInspectPort = 9333
        // JSONSerialization may surface integral numbers as Double; ensure
        // the validation applies in that path too.
        let config: [String: Any] = [
            "hostBrowser": [
                "cdpInspect": [
                    "port": Double(70000),
                ]
            ]
        ]
        SettingsStore.applyHostBrowserCdpInspectConfig(config, into: store)
        XCTAssertEqual(store.hostBrowserCdpInspectPort, 9222)
    }

    func testApplyDaemonConfigRejectsBothInvalidHostAndPort() {
        store.hostBrowserCdpInspectHost = "127.0.0.1"
        store.hostBrowserCdpInspectPort = 9333

        let config: [String: Any] = [
            "hostBrowser": [
                "cdpInspect": [
                    "host": "attacker.example.com",
                    "port": -5,
                ]
            ]
        ]
        SettingsStore.applyHostBrowserCdpInspectConfig(config, into: store)

        XCTAssertEqual(store.hostBrowserCdpInspectHost, "localhost")
        XCTAssertEqual(store.hostBrowserCdpInspectPort, 9222)
    }

    func testApplyDaemonConfigIgnoresEmptyHostAndLeavesExistingValue() {
        store.hostBrowserCdpInspectHost = "127.0.0.1"
        let config: [String: Any] = [
            "hostBrowser": [
                "cdpInspect": [
                    "host": "",
                ]
            ]
        ]
        SettingsStore.applyHostBrowserCdpInspectConfig(config, into: store)
        // Empty host is a "key not set" signal, not invalid — we leave the
        // existing value untouched (same contract as missing keys).
        XCTAssertEqual(store.hostBrowserCdpInspectHost, "127.0.0.1")
    }

    // MARK: - Sanitize-and-patch-back behaviour

    func testApplyDaemonConfigPatchesSanitizedHostBackToDaemon() {
        // An invalid (non-loopback) host from the daemon must be both
        // sanitized in-memory AND persisted back to the daemon config so
        // the bad value does not reappear on the next reload.
        XCTAssertTrue(mockSettingsClient.patchConfigCalls.isEmpty)

        let config: [String: Any] = [
            "hostBrowser": [
                "cdpInspect": [
                    "host": "attacker.example.com",
                ]
            ]
        ]
        SettingsStore.applyHostBrowserCdpInspectConfig(config, into: store)

        // In-memory fallback applies immediately.
        XCTAssertEqual(store.hostBrowserCdpInspectHost, "localhost")

        // A patch with the sanitized default is emitted asynchronously.
        waitForPatchCount(1)
        let patch = lastCdpInspectPatch()
        XCTAssertNotNil(patch, "expected a hostBrowser.cdpInspect patch payload")
        XCTAssertEqual(patch?["host"] as? String, "localhost")
        XCTAssertNil(patch?["port"])
        XCTAssertNil(patch?["enabled"])
    }

    func testApplyDaemonConfigPatchesSanitizedPortBackToDaemon() {
        // An out-of-range port from the daemon must be both sanitized
        // in-memory AND persisted back to the daemon config so the bad
        // value does not reappear on the next reload.
        XCTAssertTrue(mockSettingsClient.patchConfigCalls.isEmpty)

        let config: [String: Any] = [
            "hostBrowser": [
                "cdpInspect": [
                    "port": 70000,
                ]
            ]
        ]
        SettingsStore.applyHostBrowserCdpInspectConfig(config, into: store)

        // In-memory fallback applies immediately.
        XCTAssertEqual(store.hostBrowserCdpInspectPort, 9222)

        // A patch with the sanitized default is emitted asynchronously.
        waitForPatchCount(1)
        let patch = lastCdpInspectPatch()
        XCTAssertNotNil(patch, "expected a hostBrowser.cdpInspect patch payload")
        XCTAssertEqual(patch?["port"] as? Int, 9222)
        XCTAssertNil(patch?["host"])
        XCTAssertNil(patch?["enabled"])
    }

    func testApplyDaemonConfigPatchesBothSanitizedHostAndPortBackToDaemon() {
        XCTAssertTrue(mockSettingsClient.patchConfigCalls.isEmpty)

        let config: [String: Any] = [
            "hostBrowser": [
                "cdpInspect": [
                    "host": "attacker.example.com",
                    "port": -5,
                ]
            ]
        ]
        SettingsStore.applyHostBrowserCdpInspectConfig(config, into: store)

        XCTAssertEqual(store.hostBrowserCdpInspectHost, "localhost")
        XCTAssertEqual(store.hostBrowserCdpInspectPort, 9222)

        // One patch per sanitization path.
        waitForPatchCount(2)

        // Assert BOTH sanitized fields were patched back, regardless of
        // which order the two background tasks flushed in.
        var sawHostPatch = false
        var sawPortPatch = false
        for payload in mockSettingsClient.patchConfigCalls {
            guard let hostBrowser = payload["hostBrowser"] as? [String: Any],
                  let cdpInspect = hostBrowser["cdpInspect"] as? [String: Any] else {
                continue
            }
            if let host = cdpInspect["host"] as? String {
                XCTAssertEqual(host, "localhost")
                sawHostPatch = true
            }
            if let port = cdpInspect["port"] as? Int {
                XCTAssertEqual(port, 9222)
                sawPortPatch = true
            }
        }
        XCTAssertTrue(sawHostPatch, "expected a patch setting host back to localhost")
        XCTAssertTrue(sawPortPatch, "expected a patch setting port back to 9222")
    }

    func testApplyDaemonConfigDoesNotPatchWhenValuesAreValid() {
        // Valid config values must NOT trigger a patch. This guards
        // against any infinite-loop regression (patch -> refresh ->
        // patch -> ...) in the normal happy path.
        let config: [String: Any] = [
            "hostBrowser": [
                "cdpInspect": [
                    "enabled": true,
                    "host": "127.0.0.1",
                    "port": 9333,
                    "probeTimeoutMs": 750,
                ]
            ]
        ]
        SettingsStore.applyHostBrowserCdpInspectConfig(config, into: store)

        // Give any stray background Task a chance to flush. If a patch
        // were incorrectly emitted it would show up within this window.
        let expectation = XCTestExpectation(description: "allow background tasks to flush")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { expectation.fulfill() }
        wait(for: [expectation], timeout: 1.0)

        XCTAssertTrue(
            mockSettingsClient.patchConfigCalls.isEmpty,
            "valid daemon config values must not trigger any patch"
        )
    }

    func testApplyDaemonConfigDoesNotPatchWhenHostKeyIsAbsent() {
        // Missing host key (or empty string, which is the same contract)
        // must not trigger a patch — only an *invalid* value should.
        let config: [String: Any] = [
            "hostBrowser": [
                "cdpInspect": [
                    "enabled": true,
                ]
            ]
        ]
        SettingsStore.applyHostBrowserCdpInspectConfig(config, into: store)

        let expectation = XCTestExpectation(description: "allow background tasks to flush")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { expectation.fulfill() }
        wait(for: [expectation], timeout: 1.0)

        XCTAssertTrue(mockSettingsClient.patchConfigCalls.isEmpty)
    }
}
