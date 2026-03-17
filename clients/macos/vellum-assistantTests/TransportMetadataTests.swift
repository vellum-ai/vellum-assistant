import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

final class TransportMetadataTests: XCTestCase {

    // MARK: - Default local metadata

    func testDefaultLocalMetadataHasRuntimeFlatRouteMode() {
        let metadata = TransportMetadata.defaultLocal
        XCTAssertEqual(metadata.routeMode, .runtimeFlat)
    }

    func testDefaultLocalMetadataHasBearerTokenAuthMode() {
        let metadata = TransportMetadata.defaultLocal
        XCTAssertEqual(metadata.authMode, .bearerToken)
    }

    func testDefaultLocalMetadataHasNilPlatformAssistantId() {
        let metadata = TransportMetadata.defaultLocal
        XCTAssertNil(metadata.platformAssistantId)
    }

    // MARK: - Managed (platform proxy) metadata

    func testManagedMetadataStoresAllFields() {
        let metadata = TransportMetadata(
            routeMode: .platformAssistantProxy,
            authMode: .sessionToken,
            platformAssistantId: "test-uuid-123"
        )
        XCTAssertEqual(metadata.routeMode, .platformAssistantProxy)
        XCTAssertEqual(metadata.authMode, .sessionToken)
        XCTAssertEqual(metadata.platformAssistantId, "test-uuid-123")
    }

    // MARK: - Init defaults

    func testInitDefaultsMatchDefaultLocal() {
        let metadata = TransportMetadata()
        XCTAssertEqual(metadata.routeMode, .runtimeFlat)
        XCTAssertEqual(metadata.authMode, .bearerToken)
        XCTAssertNil(metadata.platformAssistantId)
    }

    func testInitWithOnlyRouteMode() {
        let metadata = TransportMetadata(routeMode: .platformAssistantProxy)
        XCTAssertEqual(metadata.routeMode, .platformAssistantProxy)
        // Other fields should still have defaults.
        XCTAssertEqual(metadata.authMode, .bearerToken)
        XCTAssertNil(metadata.platformAssistantId)
    }

    func testInitWithOnlyAuthMode() {
        let metadata = TransportMetadata(authMode: .sessionToken)
        XCTAssertEqual(metadata.authMode, .sessionToken)
        // Other fields should still have defaults.
        XCTAssertEqual(metadata.routeMode, .runtimeFlat)
        XCTAssertNil(metadata.platformAssistantId)
    }

    // MARK: - RouteMode enum coverage

    func testRouteModeRuntimeFlatIsNotEqualToPlatformAssistantProxy() {
        XCTAssertNotEqual(RouteMode.runtimeFlat, RouteMode.platformAssistantProxy)
    }

    // MARK: - AuthMode enum coverage

    func testAuthModeEnumCasesAreDistinct() {
        XCTAssertNotEqual(AuthMode.bearerToken, AuthMode.sessionToken)
    }

    // MARK: - DaemonConfig transportMetadata

    func testDaemonConfigDefaultsToDefaultLocalMetadata() {
        let config = DaemonConfig(
            transport: .http(baseURL: "https://example.com", bearerToken: nil, conversationKey: "test"),
            transportMetadata: .defaultLocal,

        )
        XCTAssertEqual(config.transportMetadata.routeMode, .runtimeFlat)
        XCTAssertEqual(config.transportMetadata.authMode, .bearerToken)
        XCTAssertNil(config.transportMetadata.platformAssistantId)
    }

    func testDaemonConfigWithManagedMetadata() {
        let managedMetadata = TransportMetadata(
            routeMode: .platformAssistantProxy,
            authMode: .sessionToken,
            platformAssistantId: "platform-uuid"
        )
        let config = DaemonConfig(
            transport: .http(baseURL: "https://platform.vellum.ai", bearerToken: nil, conversationKey: "key"),
            transportMetadata: managedMetadata,

        )
        XCTAssertEqual(config.transportMetadata.routeMode, .platformAssistantProxy)
        XCTAssertEqual(config.transportMetadata.authMode, .sessionToken)
        XCTAssertEqual(config.transportMetadata.platformAssistantId, "platform-uuid")
    }
}
