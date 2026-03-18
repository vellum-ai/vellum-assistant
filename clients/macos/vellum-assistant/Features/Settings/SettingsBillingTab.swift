import SwiftUI
import VellumAssistantShared

/// Billing tab — shows current balance, degradation warning, and Stripe top-up.
@MainActor
struct SettingsBillingTab: View {
    var authManager: AuthManager

    @State private var summary: BillingSummaryResponse?
    @State private var isLoading: Bool = true
    @State private var error: String?
    @State private var topUpAmount: String = ""
    @State private var isProcessingTopUp: Bool = false
    @State private var topUpError: String?
    @State private var hostWindow: NSWindow?

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            balanceCard
            if isLoading {
                addFundsSkeleton
            } else if summary != nil {
                addFundsCard
            }
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
        SettingsCard(title: "Balance") {
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
                            .foregroundColor(VColor.systemNegativeStrong)
                        Text(error)
                            .font(VFont.body)
                            .foregroundColor(VColor.systemNegativeStrong)
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
                Text("Effective Balance")
                    .font(VFont.inputLabel)
                    .foregroundColor(VColor.contentSecondary)
                Text("$\(summary.effective_balance_usd)")
                    .font(VFont.title)
                    .foregroundColor(VColor.contentEmphasized)
            }

            // Degradation warning
            if summary.is_degraded {
                HStack(spacing: VSpacing.sm) {
                    VIconView(.triangleAlert, size: 14)
                        .foregroundColor(VColor.systemMidStrong)
                    Text("Pending charges could not be calculated. The balance shown may be incomplete.")
                        .font(VFont.body)
                        .foregroundColor(VColor.systemMidStrong)
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
                        .font(VFont.inputLabel)
                        .foregroundColor(VColor.contentSecondary)
                    Text("$\(summary.settled_balance_usd)")
                        .font(VFont.bodyMedium)
                        .foregroundColor(VColor.contentDefault)
                }
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    Text(summary.is_degraded ? "Pending Charges (estimated)" : "Pending Charges")
                        .font(VFont.inputLabel)
                        .foregroundColor(VColor.contentSecondary)
                    Text("$\(summary.pending_compute_usd)")
                        .font(VFont.bodyMedium)
                        .foregroundColor(summary.is_degraded ? VColor.contentSecondary : VColor.contentDefault)
                }
            }
        }
    }

    // MARK: - Add Funds Skeleton

    private var addFundsSkeleton: some View {
        SettingsCard(title: "Add Funds") {
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

    // MARK: - Add Funds Card

    private var addFundsCard: some View {
        SettingsCard(title: "Add Funds") {
            topUpContent
        }
    }

    @ViewBuilder
    private var topUpContent: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text("Amount (USD)")
                    .font(VFont.inputLabel)
                    .foregroundColor(VColor.contentSecondary)
                VTextField(
                    placeholder: "Enter amount",
                    text: $topUpAmount
                )
                .frame(maxWidth: 400)
            }

            VButton(
                label: isProcessingTopUp ? "Processing..." : "Add funds",
                style: .primary,
                isDisabled: isProcessingTopUp || topUpAmount.isEmpty
            ) {
                Task { await handleTopUp() }
            }

            if let topUpError {
                HStack(spacing: VSpacing.sm) {
                    VIconView(.circleAlert, size: 14)
                        .foregroundColor(VColor.systemNegativeStrong)
                    Text(topUpError)
                        .font(VFont.body)
                        .foregroundColor(VColor.systemNegativeStrong)
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
        guard let amount = Double(topUpAmount) else {
            topUpError = "Please enter a valid amount."
            return
        }

        if let summary, let minimum = Double(summary.minimum_top_up_usd), amount < minimum {
            topUpError = "Minimum top-up amount is $\(summary.minimum_top_up_usd)."
            return
        }

        let normalizedAmount = String(format: "%.2f", amount)

        isProcessingTopUp = true
        topUpError = nil
        defer { isProcessingTopUp = false }

        do {
            let checkoutURL = try await BillingService.shared.createTopUpCheckout(amountUsd: normalizedAmount)
            NSWorkspace.shared.open(checkoutURL)
            topUpAmount = ""
        } catch {
            self.topUpError = "Failed to create checkout session. Please try again."
        }
    }
}
