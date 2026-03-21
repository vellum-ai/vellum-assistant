import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

@MainActor
final class AppServicesConnectionReconfigureTests: XCTestCase {

    func testReconfigurePreservesConnectionManagerIdentity() {
        let services = AppServices()
        let originalIdentity = ObjectIdentifier(services.connectionManager)

        services.reconfigureConnection(instanceDir: "/tmp/test", conversationKey: "key")

        XCTAssertEqual(
            ObjectIdentifier(services.connectionManager), originalIdentity,
            "reconfigureConnection must preserve GatewayConnectionManager object identity"
        )
    }

    func testReconfigureUpdatesInstanceDir() {
        let services = AppServices()

        services.reconfigureConnection(instanceDir: "/tmp/test-instance", conversationKey: "new-key")

        XCTAssertEqual(services.connectionManager.instanceDir, "/tmp/test-instance")
    }

    func testSettingsStoreRetainsWorkingConnectionAfterReconfigure() {
        let services = AppServices()
        let settingsStore = services.settingsStore
        _ = settingsStore

        let originalClient = services.connectionManager

        services.reconfigureConnection(conversationKey: "key")

        XCTAssertTrue(
            services.connectionManager === originalClient,
            "connectionManager should remain the same object after reconfigure"
        )
    }
}
