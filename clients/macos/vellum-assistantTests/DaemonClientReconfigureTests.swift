import XCTest
@testable import VellumAssistantShared

@MainActor
final class GatewayConnectionManagerReconfigureTests: XCTestCase {

    private var client: GatewayConnectionManager!

    override func setUp() {
        super.setUp()
        client = GatewayConnectionManager()
    }

    override func tearDown() {
        client.disconnect()
        client = nil
        super.tearDown()
    }

    func testReconfigurePreservesObjectIdentity() {
        let originalIdentity = ObjectIdentifier(client!)
        client.reconfigure(conversationKey: "test-key")
        XCTAssertEqual(ObjectIdentifier(client!), originalIdentity,
            "reconfigure must preserve object identity")
    }

    func testReconfigureClearsConnectionState() {
        client.currentModel = "claude-3"
        client.reconfigure()
        XCTAssertNil(client.currentModel)
        XCTAssertNil(client.assistantVersion)
        XCTAssertNil(client.latestMemoryStatus)
        XCTAssertFalse(client.isConnected)
    }

    func testReconfigureSetsIsConnectedToFalse() {
        client.isConnected = true
        client.reconfigure()
        XCTAssertFalse(client.isConnected)
    }

    func testWeakReferencesSurviveReconfigure() {
        weak var weakClient = client
        _ = { weakClient = nil }
        XCTAssertNotNil(weakClient)
        client.reconfigure()
        XCTAssertNotNil(weakClient)
        XCTAssertTrue(weakClient === client)
    }
}
