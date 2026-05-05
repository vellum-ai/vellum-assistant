import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

@MainActor
final class SettingsBillingTabFeatureFlagTests: XCTestCase {
    func testProPlanAdjustReadsFlagFromStore() {
        AssistantFeatureFlagResolver.writeCachedFlags(["pro-plan-adjust": true])
        defer { AssistantFeatureFlagResolver.clearCachedFlags() }

        let store = AssistantFeatureFlagStore()
        let view = SettingsBillingTab(
            authManager: AuthManager(),
            assistantFeatureFlagStore: store,
            initialSummary: nil
        )
        XCTAssertTrue(view.isProPlanAdjustEnabled)
    }

    func testProPlanAdjustDefaultsFalseWhenNoOverride() {
        AssistantFeatureFlagResolver.clearCachedFlags()
        let store = AssistantFeatureFlagStore()
        let view = SettingsBillingTab(
            authManager: AuthManager(),
            assistantFeatureFlagStore: store,
            initialSummary: nil
        )
        XCTAssertFalse(view.isProPlanAdjustEnabled)
    }
}
