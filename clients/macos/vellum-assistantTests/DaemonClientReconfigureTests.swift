import XCTest
@testable import VellumAssistantShared

@MainActor
final class DaemonClientReconfigureTests: XCTestCase {

    private var client: DaemonClient!

    override func setUp() {
        super.setUp()
        client = DaemonClient()
    }

    override func tearDown() {
        client.disconnect()
        client = nil
        super.tearDown()
    }

    // MARK: - Object identity preservation

    func testReconfigurePreservesObjectIdentity() {
        let originalIdentity = ObjectIdentifier(client!)

        let newConfig = DaemonConfig(transport: .http(
            baseURL: "http://localhost:9999",
            bearerToken: "test-token",
            conversationKey: "test-key"
        ))
        client.reconfigure(config: newConfig)

        XCTAssertEqual(ObjectIdentifier(client!), originalIdentity,
            "Reconfigure must preserve DaemonClient object identity")
    }

    func testReconfigureUpdatesConfig() {
        let newConfig = DaemonConfig(transport: .http(
            baseURL: "http://localhost:9999",
            bearerToken: "new-token",
            conversationKey: "new-key"
        ))
        client.reconfigure(config: newConfig)

        if case .http(let baseURL, _, _) = client.config.transport {
            XCTAssertEqual(baseURL, "http://localhost:9999")
        } else {
            XCTFail("Expected HTTP transport after reconfigure")
        }
    }

    func testReconfigureResetsConnectionState() {
        // Simulate some connection state
        client.httpPort = 7821
        client.currentModel = "claude-3"

        let newConfig = DaemonConfig(transport: .http(
            baseURL: "http://localhost:9999",
            bearerToken: nil,
            conversationKey: "key"
        ))
        client.reconfigure(config: newConfig)

        XCTAssertNil(client.httpPort, "httpPort should be reset after reconfigure")
        XCTAssertNil(client.currentModel, "currentModel should be reset after reconfigure")
        XCTAssertNil(client.daemonVersion, "daemonVersion should be reset after reconfigure")
        XCTAssertNil(client.latestMemoryStatus, "latestMemoryStatus should be reset after reconfigure")
        XCTAssertFalse(client.isBlobTransportAvailable, "isBlobTransportAvailable should be false after reconfigure")
        XCTAssertFalse(client.isConnected, "isConnected should be false after reconfigure")
    }

    func testReconfigurePreservesCallbacks() {
        var callbackInvoked = false
        client.onOpenUrl = { _ in
            callbackInvoked = true
        }

        let newConfig = DaemonConfig(transport: .http(
            baseURL: "http://localhost:9999",
            bearerToken: nil,
            conversationKey: "key"
        ))
        client.reconfigure(config: newConfig)

        // The callback closure should still be set after reconfigure
        XCTAssertNotNil(client.onOpenUrl, "Callbacks should be preserved after reconfigure")

        // Invoke the callback to verify it still works
        client.onOpenUrl?(OpenUrlMessage(type: "open_url", url: "https://example.com"))
        XCTAssertTrue(callbackInvoked, "Preserved callback should still be invocable")
    }

    func testReconfigureBetweenHTTPEndpoints() {
        // Start with default HTTP config
        XCTAssertNotNil(client.config)

        // Reconfigure to a different HTTP endpoint
        let httpConfig = DaemonConfig(transport: .http(
            baseURL: "http://remote-host:8080",
            bearerToken: "bearer-123",
            conversationKey: "conv-key"
        ))
        client.reconfigure(config: httpConfig)

        if case .http(let baseURL, let token, let key) = client.config.transport {
            XCTAssertEqual(baseURL, "http://remote-host:8080")
            XCTAssertEqual(token, "bearer-123")
            XCTAssertEqual(key, "conv-key")
        } else {
            XCTFail("Expected HTTP transport after reconfigure")
        }
    }

    func testMultipleReconfiguresPreserveIdentity() {
        let originalIdentity = ObjectIdentifier(client!)

        // First reconfigure
        client.reconfigure(config: DaemonConfig(transport: .http(
            baseURL: "http://host-1:8080",
            bearerToken: nil,
            conversationKey: "key-1"
        )))
        XCTAssertEqual(ObjectIdentifier(client!), originalIdentity)

        // Second reconfigure
        client.reconfigure(config: DaemonConfig(transport: .http(
            baseURL: "http://host-2:8080",
            bearerToken: nil,
            conversationKey: "key-2"
        )))
        XCTAssertEqual(ObjectIdentifier(client!), originalIdentity)

        // Third reconfigure back to default
        client.reconfigure(config: .default)
        XCTAssertEqual(ObjectIdentifier(client!), originalIdentity)
    }

    // MARK: - Weak reference survival

    func testWeakReferencesSurviveReconfigure() {
        // Simulate what RecordingManager does: hold a weak reference
        weak var weakClient = client
        _ = { weakClient = nil }  // prevent "never mutated" warning; not called

        XCTAssertNotNil(weakClient, "Weak reference should be non-nil before reconfigure")

        client.reconfigure(config: DaemonConfig(transport: .http(
            baseURL: "http://localhost:9999",
            bearerToken: nil,
            conversationKey: "key"
        )))

        XCTAssertNotNil(weakClient, "Weak reference should survive reconfigure (same object)")
        XCTAssertTrue(weakClient === client, "Weak reference should point to the same object")
    }
}
