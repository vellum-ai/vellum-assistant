import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

/// Behavioral tests for the new `PlanCard` and the `SettingsBillingTab.planRenewalLine`
/// derivation. These exercise the resolved view-model (`PlanCard.DisplayState`,
/// `SettingsBillingTab.PlanRenewalLine`) rather than the rendered SwiftUI tree —
/// the test target doesn't depend on ViewInspector, so we assert on the props the
/// view computes from its inputs.
@MainActor
final class PlanCardTests: XCTestCase {

    // MARK: - Fixtures

    private func makePlanCatalog() -> [PlanCatalogEntry] {
        [
            PlanCatalogEntry(
                id: "base",
                name: "Base",
                price_cents: 0,
                billing_interval: "month",
                included_features: [
                    "Pay-as-you-go credits",
                    "Default machine size"
                ]
            ),
            PlanCatalogEntry(
                id: "pro",
                name: "Pro",
                price_cents: 2500,
                billing_interval: "month",
                included_features: [
                    "Larger machine size",
                    "Bundled credits",
                    "Managed email subdomain",
                    "Managed Twilio phone numbers",
                    "90-day grace period on cancellation"
                ]
            )
        ]
    }

    private func makeProSubscription(
        cancelAtPeriodEnd: Bool = false,
        cancelAt: String? = nil,
        currentPeriodEnd: String? = "2026-06-01T00:00:00Z",
        status: String? = "active"
    ) -> SubscriptionResponse {
        SubscriptionResponse(
            plan_id: "pro",
            status: status,
            current_period_end: currentPeriodEnd,
            cancel_at_period_end: cancelAtPeriodEnd,
            cancel_at: cancelAt
        )
    }

    private func makeBaseSubscription() -> SubscriptionResponse {
        SubscriptionResponse(
            plan_id: "base",
            status: nil,
            current_period_end: nil,
            cancel_at_period_end: false,
            cancel_at: nil
        )
    }

    // MARK: - PlanCard.DisplayState

    func testProSubscriptionRendersCrownAndManageButton() {
        let card = PlanCard(
            subscription: makeProSubscription(),
            plans: makePlanCatalog(),
            isLoading: false,
            error: nil,
            onManage: {}
        )

        guard case let .loaded(planName, subtitle, buttonLabel, isPro) = card.displayState else {
            XCTFail("Expected .loaded state for pro subscription, got \(card.displayState)")
            return
        }
        XCTAssertEqual(planName, "PRO Plan")
        XCTAssertEqual(buttonLabel, "Manage")
        XCTAssertTrue(isPro)
        XCTAssertEqual(
            subtitle,
            "Larger machine size, Bundled credits, Managed email subdomain",
            "Subtitle should be the first 3 features comma-joined"
        )
    }

    func testBaseSubscriptionRendersUpgradeCTA() {
        let card = PlanCard(
            subscription: makeBaseSubscription(),
            plans: makePlanCatalog(),
            isLoading: false,
            error: nil,
            onManage: {}
        )

        guard case let .loaded(planName, subtitle, buttonLabel, isPro) = card.displayState else {
            XCTFail("Expected .loaded state for base subscription, got \(card.displayState)")
            return
        }
        XCTAssertEqual(planName, "Base Plan")
        XCTAssertEqual(buttonLabel, "Upgrade to Pro")
        XCTAssertFalse(isPro)
        XCTAssertEqual(
            subtitle,
            "Pay-as-you-go credits, Default machine size",
            "Subtitle should join all features when there are fewer than 3"
        )
    }

    func testLoadingStateShortCircuitsBeforeData() {
        let card = PlanCard(
            subscription: nil,
            plans: nil,
            isLoading: true,
            error: nil,
            onManage: {}
        )
        XCTAssertEqual(card.displayState, .loading)
    }

    func testErrorStateWhenSubscriptionMissing() {
        let card = PlanCard(
            subscription: nil,
            plans: nil,
            isLoading: false,
            error: "Boom",
            onManage: {}
        )
        XCTAssertEqual(card.displayState, .error(message: "Boom", buttonLabel: "Manage Plan"))
    }

    /// Without a fallback CTA in the error state, an `auto-credit-topup`-disabled
    /// user hitting a transient `/billing/subscription` failure has no path to
    /// billing settings — the prior simple "Adjust Plan" card always had a button.
    func testErrorStateExposesManageButton() {
        var manageInvocations = 0
        let card = PlanCard(
            subscription: nil,
            plans: nil,
            isLoading: false,
            error: "Network is down",
            onManage: { manageInvocations += 1 }
        )

        guard case let .error(message, buttonLabel) = card.displayState else {
            XCTFail("Expected .error state, got \(card.displayState)")
            return
        }
        XCTAssertEqual(message, "Network is down")
        XCTAssertEqual(buttonLabel, "Manage Plan")

        card.onManage()
        XCTAssertEqual(manageInvocations, 1)
    }

    // MARK: - SettingsBillingTab.planRenewalLine

    func testCancellingSubscriptionRendersCancelLine() {
        let cancelISO = "2026-09-15T00:00:00Z"
        let view = SettingsBillingTab(
            authManager: AuthManager(),
            assistantFeatureFlagStore: AssistantFeatureFlagStore(),
            initialSummary: nil,
            initialSubscription: makeProSubscription(
                cancelAtPeriodEnd: true,
                cancelAt: cancelISO,
                currentPeriodEnd: "2026-06-01T00:00:00Z"
            ),
            initialPlans: makePlanCatalog()
        )

        guard case let .cancels(formatted) = view.planRenewalLine else {
            XCTFail("Expected .cancels for cancelling subscription, got \(String(describing: view.planRenewalLine))")
            return
        }
        // The exact rendered string depends on the test runner's locale (e.g.
        // Eastern Arabic numerals under `ar`/`fa` flip "2026" → "٢٠٢٦"), so we
        // only verify the source ISO resolved cleanly rather than falling
        // through to the raw string.
        XCTAssertFalse(formatted.isEmpty, "Expected formatted date, got empty string")
        XCTAssertNotEqual(formatted, cancelISO, "Should have parsed and reformatted, not echoed raw ISO")
    }

    func testActiveProSubscriptionRendersRenewsLine() {
        let view = SettingsBillingTab(
            authManager: AuthManager(),
            assistantFeatureFlagStore: AssistantFeatureFlagStore(),
            initialSummary: nil,
            initialSubscription: makeProSubscription(cancelAtPeriodEnd: false),
            initialPlans: makePlanCatalog()
        )

        guard case let .renews(formatted) = view.planRenewalLine else {
            XCTFail("Expected .renews for active pro subscription, got \(String(describing: view.planRenewalLine))")
            return
        }
        // Locale-stable: don't assert on year digits since non-Western locales
        // render them differently (see testCancellingSubscriptionRendersCancelLine).
        XCTAssertFalse(formatted.isEmpty)
        XCTAssertNotEqual(formatted, "2026-06-01T00:00:00Z", "Should have parsed and reformatted, not echoed raw ISO")
    }

    func testBaseSubscriptionRendersNoRenewalLine() {
        let view = SettingsBillingTab(
            authManager: AuthManager(),
            assistantFeatureFlagStore: AssistantFeatureFlagStore(),
            initialSummary: nil,
            initialSubscription: makeBaseSubscription(),
            initialPlans: makePlanCatalog()
        )
        XCTAssertNil(view.planRenewalLine)
    }

    /// Stripe sometimes flips `cancel_at_period_end=true` before populating
    /// `cancel_at`. The line should still render using `current_period_end` as
    /// the fallback so the user isn't left without an end-date during that
    /// brief Stripe scheduling window.
    func testCancellingSubscriptionWithoutExplicitCancelAtFallsBackToPeriodEnd() {
        let view = SettingsBillingTab(
            authManager: AuthManager(),
            assistantFeatureFlagStore: AssistantFeatureFlagStore(),
            initialSummary: nil,
            initialSubscription: makeProSubscription(
                cancelAtPeriodEnd: true,
                cancelAt: nil,
                currentPeriodEnd: "2026-06-01T00:00:00Z"
            ),
            initialPlans: makePlanCatalog()
        )

        guard case let .cancels(formatted) = view.planRenewalLine else {
            XCTFail("Expected .cancels using current_period_end fallback")
            return
        }
        XCTAssertFalse(formatted.isEmpty)
        XCTAssertNotEqual(formatted, "2026-06-01T00:00:00Z", "Should have parsed and reformatted, not echoed raw ISO")
    }

    /// Once Stripe transitions the subscription to `status: "canceled"` (after
    /// the period elapses), the stored `current_period_end` is stale. Mirror
    /// the platform web's `isCanceled` gate and hide the subtitle entirely
    /// rather than rendering "Renews on <stale date>".
    func testCanceledStatusHidesRenewalLine() {
        let view = SettingsBillingTab(
            authManager: AuthManager(),
            assistantFeatureFlagStore: AssistantFeatureFlagStore(),
            initialSummary: nil,
            initialSubscription: makeProSubscription(
                cancelAtPeriodEnd: false,
                currentPeriodEnd: "2026-06-01T00:00:00Z",
                status: "canceled"
            ),
            initialPlans: makePlanCatalog()
        )
        XCTAssertNil(view.planRenewalLine)
    }
}
