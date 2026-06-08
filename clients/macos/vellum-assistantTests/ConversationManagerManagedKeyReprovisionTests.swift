import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

final class ConversationManagerManagedKeyReprovisionTests: XCTestCase {
    func testManagedAssistantsDoNotUseLocalBootstrapForKeyReprovision() {
        let assistant = makeAssistant(cloud: "vellum")

        XCTAssertFalse(
            ConversationManager.shouldReprovisionAssistantKeyViaLocalBootstrap(for: assistant)
        )
    }

    func testLegacyPlatformAssistantsDoNotUseLocalBootstrapForKeyReprovision() {
        let assistant = makeAssistant(cloud: "platform")

        XCTAssertFalse(
            ConversationManager.shouldReprovisionAssistantKeyViaLocalBootstrap(for: assistant)
        )
    }

    func testGenericRemoteAssistantsDoNotUseLocalBootstrapForKeyReprovision() {
        let assistant = makeAssistant(cloud: "aws")

        XCTAssertFalse(
            ConversationManager.shouldReprovisionAssistantKeyViaLocalBootstrap(for: assistant)
        )
    }

    func testLocalAssistantsUseLocalBootstrapForKeyReprovision() {
        let assistant = makeAssistant(cloud: "local")

        XCTAssertTrue(
            ConversationManager.shouldReprovisionAssistantKeyViaLocalBootstrap(for: assistant)
        )
    }

    func testDockerAssistantsUseLocalBootstrapForKeyReprovision() {
        let assistant = makeAssistant(cloud: "docker")

        XCTAssertTrue(
            ConversationManager.shouldReprovisionAssistantKeyViaLocalBootstrap(for: assistant)
        )
    }

    private func makeAssistant(cloud: String) -> LockfileAssistant {
        LockfileAssistant(
            assistantId: "assistant-123",
            runtimeUrl: "https://example.com",
            bearerToken: nil,
            cloud: cloud,
            project: nil,
            region: nil,
            zone: nil,
            instanceId: nil,
            hatchedAt: nil,
            baseDataDir: nil,
            gatewayPort: nil,
            instanceDir: nil
        )
    }
}
