import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

/// Behavioral tests for `ProComputeUpgradeSection`. Asserts on the derived
/// `shouldShowCard` view-model property across the matrix of subscription /
/// machine-size / loading combinations rather than inspecting the SwiftUI
/// tree (the test target doesn't depend on ViewInspector).
@MainActor
final class ProComputeUpgradeSectionTests: XCTestCase {

    // MARK: - Fixtures

    private func makeProSubscription() -> SubscriptionResponse {
        SubscriptionResponse(
            plan_id: "pro",
            status: "active",
            current_period_end: "2026-06-01T00:00:00Z",
            cancel_at_period_end: false,
            cancel_at: nil
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

    // MARK: - shouldShowCard matrix

    func testProUserWithNilMachineSizeShowsCard() {
        let section = ProComputeUpgradeSection(
            assistantId: "asst-1",
            subscription: makeProSubscription(),
            initialMachineSize: nil,
            initialIsLoading: false
        )
        XCTAssertTrue(section.shouldShowCard)
    }

    func testProUserWithSmallMachineSizeShowsCard() {
        let section = ProComputeUpgradeSection(
            assistantId: "asst-1",
            subscription: makeProSubscription(),
            initialMachineSize: "small",
            initialIsLoading: false
        )
        XCTAssertTrue(section.shouldShowCard)
    }

    func testBaseUserDoesNotShowCard() {
        let section = ProComputeUpgradeSection(
            assistantId: "asst-1",
            subscription: makeBaseSubscription(),
            initialMachineSize: "small",
            initialIsLoading: false
        )
        XCTAssertFalse(section.shouldShowCard)
    }

    func testProUserOnMediumDoesNotShowCard() {
        let section = ProComputeUpgradeSection(
            assistantId: "asst-1",
            subscription: makeProSubscription(),
            initialMachineSize: "medium",
            initialIsLoading: false
        )
        XCTAssertFalse(section.shouldShowCard)
    }

    func testProUserOnLargeDoesNotShowCard() {
        let section = ProComputeUpgradeSection(
            assistantId: "asst-1",
            subscription: makeProSubscription(),
            initialMachineSize: "large",
            initialIsLoading: false
        )
        XCTAssertFalse(section.shouldShowCard)
    }

    func testWhileLoadingDoesNotShowCard() {
        let section = ProComputeUpgradeSection(
            assistantId: "asst-1",
            subscription: makeProSubscription(),
            initialMachineSize: nil,
            initialIsLoading: true
        )
        XCTAssertFalse(section.shouldShowCard)
    }

    func testNilSubscriptionDoesNotShowCard() {
        let section = ProComputeUpgradeSection(
            assistantId: "asst-1",
            subscription: nil,
            initialMachineSize: "small",
            initialIsLoading: false
        )
        XCTAssertFalse(section.shouldShowCard)
    }

    /// When `subscription` transitions from base/nil to Pro after the view
    /// has mounted, the view's `.task(id:)` re-runs and resets
    /// `isLoadingMachineSize = true` before fetching `machine_size`. While
    /// that fetch is in flight, `shouldShowCard` must remain false so we
    /// don't flash an upgrade CTA for an assistant that may already be on
    /// medium/large. This documents the invariant enforced by keying the
    /// task on `assistantId + subscription.plan_id` and resetting the
    /// loading flag at the top of the task body.
    func testTransitionFromBaseToProDoesNotShowStaleCardWhileLoading() {
        let baseSection = ProComputeUpgradeSection(
            assistantId: "asst-1",
            subscription: makeBaseSubscription(),
            initialMachineSize: nil,
            initialIsLoading: false
        )
        XCTAssertFalse(baseSection.shouldShowCard)

        let proLoadingSection = ProComputeUpgradeSection(
            assistantId: "asst-1",
            subscription: makeProSubscription(),
            initialMachineSize: nil,
            initialIsLoading: true
        )
        XCTAssertFalse(proLoadingSection.shouldShowCard)
    }
}
