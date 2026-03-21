import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

@MainActor
final class AppServicesGatewayConnectionManagerReconfigureTests: XCTestCase {

    func testReconfigurePreservesGatewayConnectionManagerIdentity() {
        let services = AppServices()
        let originalClient = services.daemonClient
        let originalIdentity = ObjectIdentifier(originalClient)

        let newConfig = DaemonConfig(transport: .http(
            baseURL: "http://localhost:9999",
            bearerToken: "token",
            conversationKey: "key"
        ))
        services.reconfigureGatewayConnectionManager(config: newConfig)

        XCTAssertEqual(
            ObjectIdentifier(services.daemonClient), originalIdentity,
            "AppServices.reconfigureGatewayConnectionManager must preserve GatewayConnectionManager object identity"
        )
        XCTAssertTrue(
            services.daemonClient === originalClient,
            "daemonClient should be the same object after reconfigure"
        )
    }

    func testReconfigureUpdatesInstanceDir() {
        let services = AppServices()

        let httpConfig = DaemonConfig(transport: .http(
            baseURL: "http://remote:8080",
            bearerToken: "new-token",
            conversationKey: "new-key"
        ), instanceDir: "/tmp/test-instance")
        services.reconfigureGatewayConnectionManager(config: httpConfig)

        XCTAssertEqual(services.daemonClient.instanceDir, "/tmp/test-instance",
            "instanceDir should be updated after reconfigure via AppServices")
    }

    func testSettingsStoreRetainsWorkingGatewayConnectionManagerAfterReconfigure() {
        let services = AppServices()
        // Force lazy init of settingsStore so it captures the daemon client
        let settingsStore = services.settingsStore
        _ = settingsStore

        let originalClient = services.daemonClient

        services.reconfigureGatewayConnectionManager(config: DaemonConfig(transport: .http(
            baseURL: "http://new-host:8080",
            bearerToken: nil,
            conversationKey: "key"
        )))

        // Since reconfigure is in-place, the settings store's reference
        // to daemonClient is still the same object
        XCTAssertTrue(
            services.daemonClient === originalClient,
            "SettingsStore's daemon client reference should remain valid after reconfigure"
        )
    }
}
