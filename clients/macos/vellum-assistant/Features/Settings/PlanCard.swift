import SwiftUI
import VellumAssistantShared

/// Top-of-billing-tab summary of the org's current plan.
///
/// Mirrors `vellum-assistant-platform/web/src/components/app/settings/PlanCard.tsx`.
/// Renders a compact card showing the current plan (Pro / Base) with an SF Symbol
/// (`crown.fill` / `leaf.fill`), a short feature subtitle, and a primary CTA that
/// invokes `onManage`. Both the Pro "Manage" and Base "Upgrade to Pro" buttons fan
/// into the same callback so the parent owns navigation behavior.
///
/// SF Symbols are used directly instead of going through the `VIcon` (lucide)
/// registry: both glyphs ship with macOS so there's no asset bundling, they
/// render at any size with native antialiasing, and keeping a one-off off the
/// `VIcon` registry avoids a guard-test cascade.
///
/// The renewal/cancel subtitle line is rendered by the parent (`SettingsBillingTab`)
/// next to this card — see `planSection` there. Keeping the subtitle outside this
/// component keeps `PlanCard` purely presentational over the props it receives.
@MainActor
struct PlanCard: View {
    let subscription: SubscriptionResponse?
    let plans: [PlanCatalogEntry]?
    let isLoading: Bool
    let error: String?
    let onManage: () -> Void

    /// Resolved display state — exposed internally so tests can assert the
    /// branch chosen for a given (subscription, plans, isLoading, error)
    /// combination without going through SwiftUI rendering inspection.
    enum DisplayState: Equatable {
        case loading
        case loaded(planName: String, subtitle: String, buttonLabel: String, isPro: Bool)
        /// Plan/subscription fetch failed. We still render a fallback CTA so
        /// users hitting a transient error retain a path to billing settings —
        /// otherwise they have no way to manage or upgrade their plan when the
        /// API blips.
        case error(message: String, buttonLabel: String)
    }

    var displayState: DisplayState {
        if isLoading {
            return .loading
        }
        if let subscription, let plans, let currentPlan = plans.first(where: { $0.id == subscription.plan_id }) {
            let isPro = subscription.plan_id == "pro"
            // Drive the display name from the catalog entry. We keep "PRO"
            // capitalized for the Pro tier to match the platform web; for any
            // non-Pro tier we surface the catalog `name` directly so future
            // plans don't need a client-side string addition.
            let planName: String = isPro ? "PRO Plan" : "\(currentPlan.name) Plan"
            return .loaded(
                planName: planName,
                subtitle: currentPlan.included_features.prefix(3).joined(separator: ", "),
                buttonLabel: isPro ? "Manage" : "Upgrade to Pro",
                isPro: isPro
            )
        }
        return .error(message: error ?? "Unable to load plan information.", buttonLabel: "Manage Plan")
    }

    var body: some View {
        switch displayState {
        case .loading:
            loadingCard
        case let .loaded(planName, subtitle, buttonLabel, isPro):
            loadedCard(planName: planName, subtitle: subtitle, buttonLabel: buttonLabel, isPro: isPro)
        case let .error(message, buttonLabel):
            errorCard(message: message, buttonLabel: buttonLabel)
        }
    }

    // MARK: - Loaded

    private func loadedCard(planName: String, subtitle: String, buttonLabel: String, isPro: Bool) -> some View {
        SettingsCard(title: "Plan", subtitle: "Manage your subscription tier and billing.") {
            HStack(alignment: .center, spacing: VSpacing.md) {
                Image(systemName: isPro ? "crown.fill" : "leaf.fill")
                    .font(.system(size: 18))
                    .foregroundStyle(VColor.contentEmphasized)
                    .accessibilityHidden(true)

                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    Text(planName)
                        .font(VFont.titleSmall)
                        .foregroundStyle(VColor.contentEmphasized)
                    Text(subtitle)
                        .font(VFont.bodySmallDefault)
                        .foregroundStyle(VColor.contentTertiary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }

                Spacer()

                VButton(
                    label: buttonLabel,
                    style: isPro ? .outlined : .primary
                ) {
                    onManage()
                }
            }
        }
    }

    // MARK: - Loading

    private var loadingCard: some View {
        SettingsCard(title: "Plan", subtitle: "Manage your subscription tier and billing.") {
            HStack(alignment: .center, spacing: VSpacing.md) {
                VSkeletonBone(width: 120, height: 16)
                Spacer()
                VSkeletonBone(width: 80, height: 28)
            }
            .accessibilityHidden(true)
        }
    }

    // MARK: - Error

    private func errorCard(message: String, buttonLabel: String) -> some View {
        SettingsCard(title: "Plan", subtitle: "Manage your subscription tier and billing.") {
            HStack(alignment: .center, spacing: VSpacing.md) {
                HStack(spacing: VSpacing.sm) {
                    VIconView(.circleAlert, size: 14)
                        .foregroundStyle(VColor.systemNegativeStrong)
                    Text(message)
                        .font(VFont.bodyMediumLighter)
                        .foregroundStyle(VColor.systemNegativeStrong)
                }
                Spacer()
                VButton(label: buttonLabel, style: .outlined) {
                    onManage()
                }
            }
        }
    }
}
