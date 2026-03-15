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

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            balanceCard
            if summary != nil {
                addFundsCard
            }
        }
        .task {
            await loadSummary()
        }
    }

    // MARK: - Balance Card

    private var balanceCard: some View {
        SettingsCard(title: "Balance") {
            if isLoading {
                HStack(spacing: VSpacing.sm) {
                    ProgressView()
                        .controlSize(.small)
                    Text("Loading billing info...")
                        .font(VFont.body)
                        .foregroundColor(VColor.contentSecondary)
                }
            } else if let summary {
                balanceContent(summary)
            } else if let error {
                HStack(spacing: VSpacing.sm) {
                    VIconView(.circleAlert, size: 14)
                        .foregroundColor(VColor.systemNegativeStrong)
                    Text(error)
                        .font(VFont.body)
                        .foregroundColor(VColor.systemNegativeStrong)
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
                    Text("Your balance is low. Add funds to avoid service interruption.")
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
                    Text("Pending Charges")
                        .font(VFont.inputLabel)
                        .foregroundColor(VColor.contentSecondary)
                    Text("$\(summary.pending_compute_usd)")
                        .font(VFont.bodyMedium)
                        .foregroundColor(VColor.contentDefault)
                }
            }
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

    // MARK: - Actions

    private func loadSummary() async {
        isLoading = true
        error = nil
        do {
            summary = try await BillingService.shared.getBillingSummary()
        } catch {
            self.error = "Unable to load billing information. Please try again."
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

        isProcessingTopUp = true
        topUpError = nil
        defer { isProcessingTopUp = false }

        do {
            let checkoutURL = try await BillingService.shared.createTopUpCheckout(amountUsd: topUpAmount)
            NSWorkspace.shared.open(checkoutURL)
            topUpAmount = ""
        } catch {
            self.topUpError = "Failed to create checkout session. Please try again."
        }
    }
}
