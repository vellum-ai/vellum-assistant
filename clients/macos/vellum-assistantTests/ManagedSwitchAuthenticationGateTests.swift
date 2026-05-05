import VellumAssistantShared
import XCTest
@testable import VellumAssistantLib

final class ManagedSwitchAuthenticationGateTests: XCTestCase {
    func testManagedUnauthenticatedSwitchPromptsForLogin() {
        XCTAssertTrue(
            ManagedSwitchAuthenticationGate.shouldPromptForLogin(
                assistant: makeAssistant(id: "managed-a", cloud: "vellum"),
                isAuthenticated: false,
                managedAuthenticationAlreadyVerified: false
            )
        )
    }

    func testPostHatchManagedSwitchDoesNotPromptWhenAuthenticationWasVerified() {
        XCTAssertFalse(
            ManagedSwitchAuthenticationGate.shouldPromptForLogin(
                assistant: makeAssistant(id: "managed-a", cloud: "vellum"),
                isAuthenticated: false,
                managedAuthenticationAlreadyVerified: true
            )
        )
    }

    func testAuthenticatedManagedSwitchDoesNotPrompt() {
        XCTAssertFalse(
            ManagedSwitchAuthenticationGate.shouldPromptForLogin(
                assistant: makeAssistant(id: "managed-a", cloud: "vellum"),
                isAuthenticated: true,
                managedAuthenticationAlreadyVerified: false
            )
        )
    }

    func testLocalSwitchDoesNotPrompt() {
        XCTAssertFalse(
            ManagedSwitchAuthenticationGate.shouldPromptForLogin(
                assistant: makeAssistant(id: "local-a", cloud: "local"),
                isAuthenticated: false,
                managedAuthenticationAlreadyVerified: false
            )
        )
    }

    private func makeAssistant(id: String, cloud: String) -> LockfileAssistant {
        LockfileAssistant(
            assistantId: id,
            runtimeUrl: cloud == "vellum" ? VellumEnvironment.resolvedPlatformURL : nil,
            bearerToken: nil,
            cloud: cloud,
            project: nil,
            region: nil,
            zone: nil,
            instanceId: nil,
            hatchedAt: "2026-05-01T12:00:00Z",
            baseDataDir: nil,
            gatewayPort: nil,
            instanceDir: nil
        )
    }
}
