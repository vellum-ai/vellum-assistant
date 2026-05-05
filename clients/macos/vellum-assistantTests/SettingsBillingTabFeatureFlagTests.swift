import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

@MainActor
final class SettingsBillingTabFeatureFlagTests: XCTestCase {
    private let proPlanAdjustKey = "pro-plan-adjust"

    /// Build a registry containing only the `pro-plan-adjust` entry. Mirrors the
    /// pattern in `AssistantFeatureFlagResolverTests.makeRegistry` — passing an
    /// explicit registry avoids depending on `Bundle.main` resources, which are
    /// only populated for the bundled `.app` (not the SPM test target).
    private func makeRegistry(defaultEnabled: Bool) -> FeatureFlagRegistry {
        FeatureFlagRegistry(
            version: 1,
            flags: [
                FeatureFlagDefinition(
                    id: "pro-plan-adjust",
                    scope: .assistant,
                    key: proPlanAdjustKey,
                    label: "Pro Plan Adjust",
                    description: "Show the 'Adjust Plan' and 'Configure Auto Top Ups' CTAs in the macOS Settings → Billing tab.",
                    defaultEnabled: defaultEnabled
                )
            ]
        )
    }

    func testProPlanAdjustReadsFlagFromStore() {
        AssistantFeatureFlagResolver.writeCachedFlags([proPlanAdjustKey: true])
        defer { AssistantFeatureFlagResolver.clearCachedFlags() }

        let store = AssistantFeatureFlagStore(
            notificationCenter: NotificationCenter(),
            registry: makeRegistry(defaultEnabled: false)
        )
        let view = SettingsBillingTab(
            authManager: AuthManager(),
            assistantFeatureFlagStore: store,
            initialSummary: nil
        )
        XCTAssertTrue(view.isProPlanAdjustEnabled)
    }

    func testProPlanAdjustDefaultsFalseWhenNoOverride() {
        AssistantFeatureFlagResolver.clearCachedFlags()
        let store = AssistantFeatureFlagStore(
            notificationCenter: NotificationCenter(),
            registry: makeRegistry(defaultEnabled: false)
        )
        let view = SettingsBillingTab(
            authManager: AuthManager(),
            assistantFeatureFlagStore: store,
            initialSummary: nil
        )
        XCTAssertFalse(view.isProPlanAdjustEnabled)
    }
}
