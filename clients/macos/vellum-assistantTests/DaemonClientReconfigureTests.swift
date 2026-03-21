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

    func testResetPreservesObjectIdentity() {
        let originalIdentity = ObjectIdentifier(client!)
        client.resetConnectionState(instanceDir: "/tmp/test")
        XCTAssertEqual(ObjectIdentifier(client!), originalIdentity,
            "resetConnectionState must preserve object identity")
    }

    func testResetUpdatesInstanceDir() {
        client.resetConnectionState(instanceDir: "/tmp/test-instance")
        XCTAssertEqual(client.instanceDir, "/tmp/test-instance")
    }

    func testResetClearsConnectionState() {
        client.httpPort = 7821
        client.currentModel = "claude-3"

        client.resetConnectionState()

        XCTAssertNil(client.httpPort)
        XCTAssertNil(client.currentModel)
        XCTAssertNil(client.daemonVersion)
        XCTAssertNil(client.latestMemoryStatus)
        XCTAssertFalse(client.isConnected)
    }

    func testResetSetsIsConnectedToFalse() {
        client.isConnected = true
        client.resetConnectionState()
        XCTAssertFalse(client.isConnected)
    }

    func testWeakReferencesSurviveReset() {
        weak var weakClient = client
        _ = { weakClient = nil }

        XCTAssertNotNil(weakClient)
        client.resetConnectionState()
        XCTAssertNotNil(weakClient)
        XCTAssertTrue(weakClient === client)
    }
}
