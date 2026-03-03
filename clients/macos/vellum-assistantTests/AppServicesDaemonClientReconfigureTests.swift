import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

@MainActor
final class AppServicesDaemonClientReconfigureTests: XCTestCase {

    func testReconfigurePreservesDaemonClientIdentity() {
        let services = AppServices()
        let originalClient = services.daemonClient
        let originalIdentity = ObjectIdentifier(originalClient)

        let newConfig = DaemonConfig(transport: .http(
            baseURL: "http://localhost:9999",
            bearerToken: "token",
            conversationKey: "key"
        ))
        services.reconfigureDaemonClient(config: newConfig)

        XCTAssertEqual(
            ObjectIdentifier(services.daemonClient), originalIdentity,
            "AppServices.reconfigureDaemonClient must preserve DaemonClient object identity"
        )
        XCTAssertTrue(
            services.daemonClient === originalClient,
            "daemonClient should be the same object after reconfigure"
        )
    }

    func testReconfigureUpdatesTransport() {
        let services = AppServices()

        let httpConfig = DaemonConfig(transport: .http(
            baseURL: "http://remote:8080",
            bearerToken: "new-token",
            conversationKey: "new-key"
        ))
        services.reconfigureDaemonClient(config: httpConfig)

        if case .http(let baseURL, _, _) = services.daemonClient.config.transport {
            XCTAssertEqual(baseURL, "http://remote:8080")
        } else {
            XCTFail("Expected HTTP transport after reconfigure")
        }
    }

    func testSettingsStoreRetainsWorkingDaemonClientAfterReconfigure() {
        let services = AppServices()
        // Force lazy init of settingsStore so it captures the daemon client
        let settingsStore = services.settingsStore
        _ = settingsStore

        let originalClient = services.daemonClient

        services.reconfigureDaemonClient(config: DaemonConfig(transport: .http(
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
