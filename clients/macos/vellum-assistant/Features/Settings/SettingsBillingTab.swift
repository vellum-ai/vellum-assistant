import SwiftUI
import VellumAssistantShared

/// Billing tab — shows current balance, degradation warning, and Stripe top-up.
@MainActor
struct SettingsBillingTab: View {
    var authManager: AuthManager
    var assistantFeatureFlagStore: AssistantFeatureFlagStore

    @State private var summary: BillingSummaryResponse?
    @State private var isLoading: Bool = true
    @State private var error: String?
    @State private var selectedAmount: String = ""

    private var topUpAmounts: [String] {
        summary?.allowed_top_up_amounts ?? []
    }

    private var effectiveAmount: String {
        topUpAmounts.contains(selectedAmount) ? selectedAmount : topUpAmounts.first ?? ""
    }

    var isProPlanAdjustEnabled: Bool {
        assistantFeatureFlagStore.isEnabled("pro-plan-adjust")
    }

    @State private var isProcessingTopUp: Bool = false
    @State private var topUpError: String?
    @State private var hostWindow: NSWindow?
    @State private var showEarnCreditsModal: Bool = false

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            balanceCard
            if isProPlanAdjustEnabled {
                adjustPlanCard
            }
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

    // MARK: - Adjust Plan Card

    private var adjustPlanCard: some View {
        SettingsCard(title: "Adjust Plan") {
            VButton(
                label: "Adjust Plan",
                style: .primary
            ) {
                NSWorkspace.shared.open(AppURLs.billingSettings)
            }
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
                if isProPlanAdjustEnabled {
                    VButton(
                        label: "Configure Auto Top Ups",
                        style: .outlined
                    ) {
                        NSWorkspace.shared.open(AppURLs.billingSettings)
                    }
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
        do {
            var result = try await BillingService.shared.getBillingSummary()
            if let bootstrapped = await BillingService.shared.bootstrapBillingSummaryIfNeeded(summary: result) {
                result = bootstrapped
            }
            summary = result
        } catch {
            // Only show error if we have no cached data to display
            if summary == nil {
                self.error = "Unable to load billing information. Please try again."
            }
        }
        isLoading = false
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
    /// Test-only convenience initializer that pre-populates the `summary` `@State`
    /// without going through the `loadSummary()` async path. Used by
    /// `SettingsBillingTabSubtitleTests` to exercise `addCreditsSubtitleAttributed`
    /// against a known billing summary fixture.
    init(
        authManager: AuthManager,
        assistantFeatureFlagStore: AssistantFeatureFlagStore,
        initialSummary: BillingSummaryResponse?
    ) {
        self.authManager = authManager
        self.assistantFeatureFlagStore = assistantFeatureFlagStore
        self._summary = State(initialValue: initialSummary)
    }
}
