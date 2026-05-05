import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

@MainActor
final class SettingsBillingTabFeatureFlagTests: XCTestCase {
    private let proPlanAdjustKey = "pro-plan-adjust"
    private let autoCreditTopUpKey = "auto-credit-topup"

    /// Build a registry containing the `pro-plan-adjust` and `auto-credit-topup`
    /// entries. Mirrors the pattern in `AssistantFeatureFlagResolverTests.makeRegistry`
    /// — passing an explicit registry avoids depending on `Bundle.main` resources,
    /// which are only populated for the bundled `.app` (not the SPM test target).
    private func makeRegistry(defaultEnabled: Bool) -> FeatureFlagRegistry {
        FeatureFlagRegistry(
            version: 1,
            flags: [
                FeatureFlagDefinition(
                    id: "pro-plan-adjust",
                    scope: .assistant,
                    key: proPlanAdjustKey,
                    label: "Pro Plan Adjust",
                    description: "Show the rich Plan card (current plan, features, Manage/Upgrade CTA) at the top of the macOS Settings → Billing tab. The 'Configure Auto Top Ups' CTA is gated separately on `auto-credit-topup`.",
                    defaultEnabled: defaultEnabled
                ),
                FeatureFlagDefinition(
                    id: "auto-credit-topup",
                    scope: .assistant,
                    key: autoCreditTopUpKey,
                    label: "Auto Credit Top-Up",
                    description: "Show the 'Configure Auto Top Ups' CTA in the macOS Settings → Billing tab.",
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

    func testAutoTopUpButtonReadsFlagFromStore() {
        AssistantFeatureFlagResolver.writeCachedFlags([autoCreditTopUpKey: true])
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
        XCTAssertTrue(view.isAutoCreditTopUpEnabled)
    }

    func testAutoTopUpButtonDefaultsFalseWhenNoOverride() {
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
        XCTAssertFalse(view.isAutoCreditTopUpEnabled)
    }

    /// Regression: previously the auto-top-up CTA was gated on `pro-plan-adjust`,
    /// so flipping that flag also flipped the auto-top-up button. Confirm the two
    /// flags are now fully decoupled.
    func testAutoTopUpButtonIndependentOfProPlanAdjust() {
        AssistantFeatureFlagResolver.writeCachedFlags([
            proPlanAdjustKey: true,
            autoCreditTopUpKey: false
        ])
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
        XCTAssertFalse(view.isAutoCreditTopUpEnabled)
    }
}
