import SwiftUI
import VellumAssistantShared

/// Billing tab — shows current balance, degradation warning, and Stripe top-up.
@MainActor
struct SettingsBillingTab: View {
    var authManager: AuthManager

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
    @State private var isProcessingTopUp: Bool = false
    @State private var topUpError: String?
    @State private var hostWindow: NSWindow?
    @State private var isReferralCodesEnabled: Bool = false

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            balanceCard
            if isLoading {
                addFundsSkeleton
            } else if !topUpAmounts.isEmpty {
                addFundsCard
            }
            if isReferralCodesEnabled {
                SettingsBillingReferralCard()
            }
        }
        .task {
            isReferralCodesEnabled = MacOSClientFeatureFlagManager.shared.isEnabled("referral-codes")
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
        .onReceive(NotificationCenter.default.publisher(for: .assistantFeatureFlagDidChange)) { notification in
            if let key = notification.userInfo?["key"] as? String,
               key == "referral-codes",
               let enabled = notification.userInfo?["enabled"] as? Bool {
                isReferralCodesEnabled = enabled
            }
        }
    }

    // MARK: - Balance Card

    private var balanceCard: some View {
        SettingsCard(title: "Credit Balance") {
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
                Text("Effective Credit Balance")
                    .font(VFont.bodySmallDefault)
                    .foregroundStyle(VColor.contentSecondary)
                Text("\(summary.effective_balance) credits")
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
                    Text("Settled Credit Balance")
                        .font(VFont.bodySmallDefault)
                        .foregroundStyle(VColor.contentSecondary)
                    Text("\(summary.settled_balance) credits")
                        .font(VFont.bodyMediumDefault)
                        .foregroundStyle(VColor.contentDefault)
                }
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    Text(summary.is_degraded ? "Pending Usage (estimated)" : "Pending Usage")
                        .font(VFont.bodySmallDefault)
                        .foregroundStyle(VColor.contentSecondary)
                    Text("\(summary.pending_compute) credits")
                        .font(VFont.bodyMediumDefault)
                        .foregroundStyle(summary.is_degraded ? VColor.contentSecondary : VColor.contentDefault)
                }
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
        SettingsCard(title: "Add Credits") {
            topUpContent
        }
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
                        return (label: "\(credits) ($\(amount))", value: amount)
                    }
                )
                .frame(maxWidth: 200)
                if let summary {
                    Text("\(summary.maximum_balance) max credit balance. Credits expire 12 months after purchase.")
                        .font(VFont.bodySmallDefault)
                        .foregroundStyle(VColor.contentTertiary)
                }
            }

            VButton(
                label: isProcessingTopUp ? "Processing..." : "Add credits",
                style: .primary,
                isDisabled: isProcessingTopUp
            ) {
                Task { await handleTopUp() }
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
            topUpError = "This top-up would exceed the maximum credit balance of \(summary.maximum_balance)."
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
