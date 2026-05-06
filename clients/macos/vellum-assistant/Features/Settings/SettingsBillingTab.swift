import SwiftUI
import VellumAssistantShared

/// Billing tab — shows current balance, degradation warning, and Stripe top-up.
@MainActor
struct SettingsBillingTab: View {
    var authManager: AuthManager

    @State private var summary: BillingSummaryResponse?
    @State private var subscription: SubscriptionResponse?
    @State private var plans: [PlanCatalogEntry]?
    @State private var planError: String?
    @State private var isLoading: Bool = true
    @State private var error: String?
    @State private var selectedAmount: String = ""

    private var topUpAmounts: [String] {
        summary?.allowed_top_up_amounts ?? []
    }

    private var effectiveAmount: String {
        topUpAmounts.contains(selectedAmount) ? selectedAmount : topUpAmounts.first ?? ""
    }

    @State private var isProcessingTopUp: Bool = false
    @State private var topUpError: String?
    @State private var hostWindow: NSWindow?
    @State private var showEarnCreditsModal: Bool = false

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            planSection
            balanceCard
            if isLoading {
                addFundsSkeleton
            } else if !topUpAmounts.isEmpty {
                addFundsCard
            }
        }
        .sheet(isPresented: $showEarnCreditsModal) {
            EarnCreditsModal()
        }
        .task {
            await loadSummary()
        }
        .onReceive(NotificationCenter.default.publisher(for: NSWindow.didBecomeKeyNotification)) { notification in
            guard let window = notification.object as? NSWindow,
                  window === hostWindow else { return }
            Task {
                await loadSummary()
            }
        }
        .background(WindowReader(window: $hostWindow))
    }

    // MARK: - Balance Card

    private var balanceCard: some View {
        SettingsCard(
            title: "Credit Balance",
            accessory: {
                VButton(
                    label: "Earn credits",
                    leftIcon: VIcon.gift.rawValue,
                    style: .outlined,
                    size: .compact
                ) {
                    showEarnCreditsModal = true
                }
            }
        ) {
            if isLoading {
                VStack(alignment: .leading, spacing: VSpacing.lg) {
                    // Effective balance skeleton
                    VStack(alignment: .leading, spacing: VSpacing.xs) {
                        VSkeletonBone(width: 110, height: 12)
                        VSkeletonBone(width: 80, height: 24)
                    }

                    SettingsDivider()

                    // Two-column breakdown skeleton
                    HStack(spacing: VSpacing.xl) {
                        VStack(alignment: .leading, spacing: VSpacing.xs) {
                            VSkeletonBone(width: 100, height: 12)
                            VSkeletonBone(width: 60, height: 14)
                        }
                        VStack(alignment: .leading, spacing: VSpacing.xs) {
                            VSkeletonBone(width: 110, height: 12)
                            VSkeletonBone(width: 60, height: 14)
                        }
                    }
                }
                .accessibilityHidden(true)
            } else if let summary {
                balanceContent(summary)
            } else if let error {
                VStack(alignment: .leading, spacing: VSpacing.md) {
                    HStack(spacing: VSpacing.sm) {
                        VIconView(.circleAlert, size: 14)
                            .foregroundStyle(VColor.systemNegativeStrong)
                        Text(error)
                            .font(VFont.bodyMediumLighter)
                            .foregroundStyle(VColor.systemNegativeStrong)
                    }
                    VButton(label: "Try Again", style: .outlined) {
                        Task { await loadSummary() }
                    }
                }
            }
        }
    }

    // MARK: - Balance Content

    @ViewBuilder
    private func balanceContent(_ summary: BillingSummaryResponse) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            // Effective balance — large display
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text("Balance")
                    .font(VFont.bodySmallDefault)
                    .foregroundStyle(VColor.contentSecondary)
                Text(summary.effective_balance)
                    .font(VFont.titleMedium)
                    .foregroundStyle(VColor.contentEmphasized)
            }

            // Degradation warning
            if summary.is_degraded {
                HStack(spacing: VSpacing.sm) {
                    VIconView(.triangleAlert, size: 14)
                        .foregroundStyle(VColor.systemMidStrong)
                    Text("Pending charges could not be calculated. The balance shown may be incomplete.")
                        .font(VFont.bodyMediumLighter)
                        .foregroundStyle(VColor.systemMidStrong)
                }
                .padding(VSpacing.md)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(VColor.systemMidWeak)
                .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
            }

            // Two-column breakdown
            SettingsDivider()

            HStack(spacing: VSpacing.xl) {
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    Text("Settled Balance")
                        .font(VFont.bodySmallDefault)
                        .foregroundStyle(VColor.contentSecondary)
                    Text(summary.settled_balance)
                        .font(VFont.bodyMediumDefault)
                        .foregroundStyle(VColor.contentDefault)
                }
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    Text(summary.is_degraded ? "Pending Usage (estimated)" : "Pending Usage")
                        .font(VFont.bodySmallDefault)
                        .foregroundStyle(VColor.contentSecondary)
                    Text(summary.pending_compute)
                        .font(VFont.bodyMediumDefault)
                        .foregroundStyle(summary.is_degraded ? VColor.contentSecondary : VColor.contentDefault)
                }
            }
        }
    }

    // MARK: - Plan Section

    /// Resolved subtitle line shown beneath the `PlanCard` for Pro subscriptions.
    /// Exposed for testability — see `PlanCardTests.testCancellingSubscriptionRendersCancelLine`.
    /// Returns `nil` when nothing should render below the card (loading, base
    /// plan, etc.).
    enum PlanRenewalLine: Equatable {
        case renews(String)
        case cancels(String)
    }

    var planRenewalLine: PlanRenewalLine? {
        guard let sub = subscription, sub.plan_id == "pro" else { return nil }
        // Once Stripe transitions the subscription to `canceled` (e.g. after the
        // grace period elapses) the stored `current_period_end` is stale, so
        // hide the line entirely. Mirrors the platform web's `isCanceled` gate
        // in `web/src/components/app/settings/PlanCard.tsx`.
        if sub.status == "canceled" { return nil }
        if !sub.cancel_at_period_end, let renewalISO = sub.current_period_end {
            return .renews(formatRenewalDate(renewalISO))
        }
        if sub.cancel_at_period_end, let cancelISO = sub.cancel_at ?? sub.current_period_end {
            return .cancels(formatRenewalDate(cancelISO))
        }
        return nil
    }

    /// Renders the new rich `PlanCard` plus a renewal-or-cancel subtitle line for
    /// Pro subscriptions. The subtitle lives in the parent so `PlanCard` stays a
    /// pure presentational view over its props.
    @ViewBuilder
    private var planSection: some View {
        PlanCard(
            subscription: subscription,
            plans: plans,
            isLoading: (subscription == nil || plans == nil) && planError == nil,
            error: planError,
            onManage: { NSWorkspace.shared.open(AppURLs.billingSettings) }
        )
        switch planRenewalLine {
        case let .renews(date):
            Text("Renews on \(date).")
                .font(VFont.bodySmallDefault)
                .foregroundStyle(VColor.contentTertiary)
        case let .cancels(date):
            Text("Your plan ends on \(date).")
                .font(VFont.bodySmallDefault)
                .foregroundStyle(VColor.systemMidStrong)
        case .none:
            EmptyView()
        }
    }

    // MARK: - Add Credits Skeleton

    private var addFundsSkeleton: some View {
        SettingsCard(title: "Add Credits") {
            VStack(alignment: .leading, spacing: VSpacing.md) {
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    VSkeletonBone(width: 90, height: 12)
                    VSkeletonBone(height: 28, radius: VRadius.md)
                }
                VSkeletonBone(width: 80, height: 28, radius: VRadius.md)
            }
            .accessibilityHidden(true)
        }
    }

    // MARK: - Add Credits Card

    private var addFundsCard: some View {
        SettingsCard(
            title: "Add Credits",
            subtitleAttributed: addCreditsSubtitleAttributed
        ) {
            topUpContent
        }
    }

    /// Formats the maximum balance from a billing summary as a thousands-grouped
    /// integer string (e.g. `"1,000"`), falling back to the raw server value if
    /// it can't be parsed as a positive number. Shared by `addCreditsSubtitleAttributed`
    /// and `handleTopUp()` so the formatting stays consistent.
    func formattedMaxBalance(_ summary: BillingSummaryResponse) -> String {
        let value = Int(Double(summary.maximum_balance) ?? 0)
        if value > 0 {
            let formatter = NumberFormatter()
            formatter.numberStyle = .decimal
            return formatter.string(from: NSNumber(value: value)) ?? summary.maximum_balance
        }
        return summary.maximum_balance
    }

    /// Subtitle for the Add Credits card, rendered as an attributed string so the
    /// trailing "Learn more about pricing" link is tappable. Returns nil while the
    /// billing summary is still loading. The link target is `AppURLs.pricingDocs`,
    /// which honors the `VELLUM_DOCS_BASE_URL` env override.
    var addCreditsSubtitleAttributed: AttributedString? {
        guard let summary else { return nil }
        let copy = "Credits cost $1 each, with a maximum balance of \(formattedMaxBalance(summary)). Unused credits expire 12 months after purchase."
        let markdown = "\(copy) [Learn more about pricing](\(AppURLs.pricingDocs.absoluteString))"
        // Use `try?` with a plain-text fallback so a markdown parse failure
        // (e.g. unexpected interpolated content) degrades gracefully instead
        // of crashing the Settings tab.
        guard var attributed = try? AttributedString(markdown: markdown) else {
            return AttributedString("\(copy) Learn more about pricing")
        }
        for run in attributed.runs where run.link != nil {
            attributed[run.range].underlineStyle = .single
        }
        return attributed
    }

    @ViewBuilder
    private var topUpContent: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                VDropdown(
                    "Amount",
                    placeholder: "",
                    selection: Binding(
                        get: { effectiveAmount },
                        set: { selectedAmount = $0 }
                    ),
                    options: topUpAmounts.map { amount in
                        let credits = amount.replacingOccurrences(of: ".00", with: "")
                        return (label: "\(credits) credits", value: amount)
                    }
                )
                .frame(maxWidth: 200)
            }

            HStack(spacing: VSpacing.sm) {
                VButton(
                    label: isProcessingTopUp ? "Processing..." : "Add credits",
                    style: .primary,
                    isDisabled: isProcessingTopUp
                ) {
                    Task { await handleTopUp() }
                }
                VButton(
                    label: "Configure Auto Top Ups",
                    style: .outlined
                ) {
                    NSWorkspace.shared.open(AppURLs.billingSettings)
                }
            }

            if let topUpError {
                HStack(spacing: VSpacing.sm) {
                    VIconView(.circleAlert, size: 14)
                        .foregroundStyle(VColor.systemNegativeStrong)
                    Text(topUpError)
                        .font(VFont.bodyMediumLighter)
                        .foregroundStyle(VColor.systemNegativeStrong)
                }
            }
        }
    }

    // MARK: - Helpers

    private struct WindowReader: NSViewRepresentable {
        @Binding var window: NSWindow?

        func makeNSView(context: Context) -> NSView {
            let view = NSView()
            DispatchQueue.main.async { self.window = view.window }
            return view
        }

        func updateNSView(_ nsView: NSView, context: Context) {
            DispatchQueue.main.async { self.window = nsView.window }
        }
    }

    /// Extract the first validation error message from an API error response body.
    private static func parseValidationError(_ body: String?) -> String? {
        guard let body, let data = body.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return nil
        }
        for value in json.values {
            if let messages = value as? [String], let first = messages.first {
                return first
            }
        }
        if let detail = json["detail"] as? String {
            return detail
        }
        return nil
    }

    // MARK: - Actions

    private func loadSummary() async {
        // Only show skeleton on initial load — don't flash on background refreshes
        if summary == nil {
            isLoading = true
        }
        error = nil
        planError = nil

        // Refresh the billing summary alongside the subscription + plan catalog
        // in parallel. Each fetch has its own `do/catch` so a flaky
        // `/subscription/` call still lets the balance card render (and vice
        // versa).
        //
        // Critically, we resolve the billing summary BEFORE awaiting the plan
        // metadata so a slow `/subscription/` or `/plans/` call doesn't keep
        // the balance card in skeleton state. Both `async let`s are still
        // launched concurrently, so total wall-clock time is unchanged — but
        // the balance UI flips out of loading as soon as the summary call
        // returns, independent of plan-metadata latency.
        async let summaryTask = BillingService.shared.getBillingSummary()
        async let subscriptionTask = BillingService.shared.getSubscription()
        async let plansTask = BillingService.shared.getPlanCatalog()

        do {
            var result = try await summaryTask
            if let bootstrapped = await BillingService.shared.bootstrapBillingSummaryIfNeeded(summary: result) {
                result = bootstrapped
            }
            summary = result
        } catch {
            if summary == nil {
                self.error = "Unable to load billing information. Please try again."
            }
        }
        isLoading = false

        // Each fetch is awaited independently so a flaky `/plans/` doesn't
        // discard a successfully-fetched subscription (and vice versa). On
        // refresh, the prior `@State` value is retained when a fetch
        // throws. `planError` is only set when we end up missing data the
        // card needs — preserving previously-loaded state on transient
        // refresh failures.
        if let sub = try? await subscriptionTask {
            subscription = sub
        }
        if let catalog = try? await plansTask {
            plans = catalog.plans
        }
        if subscription == nil || plans == nil {
            planError = "Unable to load plan information."
        }
    }

    /// Formats an ISO 8601 timestamp as a long-style locale date (e.g.
    /// `April 1, 2026`). Mirrors `formatGraceDate` in
    /// `web/src/lib/billing/use-billing-portal-session.ts` so the macOS and web
    /// surfaces render the same string for a given subscription. Falls back to
    /// the raw ISO string if parsing fails so the user still sees something.
    private func formatRenewalDate(_ iso: String) -> String {
        let parser = ISO8601DateFormatter()
        parser.formatOptions = [.withInternetDateTime]
        guard let date = parser.date(from: iso) else { return iso }
        let formatter = DateFormatter()
        formatter.dateStyle = .long
        formatter.timeStyle = .none
        return formatter.string(from: date)
    }

    private func handleTopUp() async {
        let amountStr = effectiveAmount
        let amount = Double(amountStr) ?? 0

        if let summary,
           let maxBalance = Double(summary.maximum_balance),
           let currentBalance = Double(summary.effective_balance),
           currentBalance + amount > maxBalance {
            let maxFormatted = formattedMaxBalance(summary)
            topUpError = "This top-up would exceed the maximum credit balance of \(maxFormatted)."
            return
        }

        isProcessingTopUp = true
        topUpError = nil
        defer { isProcessingTopUp = false }

        do {
            let checkoutURL = try await BillingService.shared.createTopUpCheckout(amount: amountStr)
            NSWorkspace.shared.open(checkoutURL)
        } catch let PlatformAPIError.serverError(_, detail) {
            self.topUpError = Self.parseValidationError(detail) ?? "Failed to create checkout session. Please try again."
        } catch {
            self.topUpError = "Failed to create checkout session. Please try again."
        }
    }
}

// MARK: - Test Support

extension SettingsBillingTab {
    /// Test-only convenience initializer that pre-populates the `summary`,
    /// `subscription`, and `plans` `@State` values without going through the
    /// `loadSummary()` async path. Used by `SettingsBillingTabSubtitleTests`
    /// and `PlanCardTests` to exercise the rendered output against known fixtures.
    init(
        authManager: AuthManager,
        initialSummary: BillingSummaryResponse?,
        initialSubscription: SubscriptionResponse? = nil,
        initialPlans: [PlanCatalogEntry]? = nil
    ) {
        self.authManager = authManager
        self._summary = State(initialValue: initialSummary)
        self._subscription = State(initialValue: initialSubscription)
        self._plans = State(initialValue: initialPlans)
    }
}
