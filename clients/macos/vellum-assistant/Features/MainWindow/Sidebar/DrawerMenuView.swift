import SwiftUI
import VellumAssistantShared

struct DrawerMenuView: View {
    let authManager: AuthManager
    let onSettings: () -> Void
    let onUsage: () -> Void
    let onDebug: () -> Void
    let onShareFeedback: () -> Void
    let onLogOut: () -> Void
    let onSignIn: () -> Void
    let onOpenBilling: () -> Void
    let onEarnCredits: () -> Void

    @State private var effectiveBalance: String?
    @State private var isLowBalance = false
    @State private var isZeroBalance = false
    @State private var bootstrapGeneration: Int = 0
    @State private var isReferralCodesEnabled: Bool = false
    @AppStorage("connectedOrganizationId") private var connectedOrgId: String?

    private var isBillingVisible: Bool {
        let _ = bootstrapGeneration  // Force recomputation when bootstrap completes
        return authManager.isAuthenticated &&
        MacOSClientFeatureFlagManager.shared.isEnabled("settings-billing") &&
        connectedOrgId != nil
    }

    private var isReferralVisible: Bool {
        isBillingVisible && isReferralCodesEnabled
    }

    var body: some View {
        VMenu {
            VMenuCustomRow {
                DrawerThemeToggle()
            }

            VMenuCustomRow {
                tightDividerLine
            }

            if let balance = effectiveBalance {
                VMenuCustomRow {
                    HStack {
                        Text("\(balance) credits")
                            .font(VFont.bodyMediumDefault)
                            .foregroundStyle(
                                isZeroBalance ? VColor.systemNegativeStrong :
                                isLowBalance ? VColor.systemMidStrong :
                                VColor.contentDefault
                            )
                        Spacer()
                        if isBillingVisible {
                            Button("Add credits") { onOpenBilling() }
                                .font(VFont.labelDefault)
                                .foregroundStyle(VColor.primaryBase)
                                .buttonStyle(.plain)
                        }
                    }
                    .frame(minHeight: VSize.rowMinHeight)
                }

                VMenuCustomRow {
                    tightDividerLine
                }

                if isReferralVisible {
                    VMenuItem(icon: VIcon.gift.rawValue, label: String(localized: "Earn credits")) {
                        onEarnCredits()
                    }

                    VMenuCustomRow {
                        tightDividerLine
                    }
                }
            }

            VMenuItem(icon: VIcon.settings.rawValue, label: String(localized: "Settings"), action: onSettings)

            VMenuItem(icon: VIcon.barChart.rawValue, label: String(localized: "Usage"), action: onUsage)
            VMenuItem(icon: VIcon.scrollText.rawValue, label: String(localized: "Logs"), action: onDebug)
            VMenuItem(icon: VIcon.messageCircle.rawValue, label: String(localized: "Share Feedback"), action: onShareFeedback)

            if authManager.isAuthenticated {
                VMenuItem(icon: VIcon.logOut.rawValue, label: String(localized: "Log Out"), action: onLogOut)
            } else {
                VMenuItem(icon: VIcon.logOut.rawValue, label: String(localized: "Log In"), action: onSignIn)
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .localBootstrapCompleted)) { _ in
            bootstrapGeneration += 1
        }
        .onReceive(NotificationCenter.default.publisher(for: .assistantFeatureFlagDidChange)) { notification in
            if let key = notification.userInfo?["key"] as? String,
               key == "referral-codes",
               let enabled = notification.userInfo?["enabled"] as? Bool {
                isReferralCodesEnabled = enabled
            }
        }
        .task {
            isReferralCodesEnabled = MacOSClientFeatureFlagManager.shared.isEnabled("referral-codes")
            await loadBalance()
        }
    }

    /// 1pt divider line without VMenuDivider's 4pt vertical padding,
    /// used for sections that should sit tight against neighboring rows.
    private var tightDividerLine: some View {
        Rectangle()
            .fill(VColor.borderBase)
            .frame(height: 1)
    }

    private func loadBalance() async {
        guard authManager.isAuthenticated else { return }
        do {
            var summary = try await BillingService.shared.getBillingSummary()
            if let bootstrapped = await BillingService.shared.bootstrapBillingSummaryIfNeeded(summary: summary) {
                summary = bootstrapped
            }
            let balanceString = summary.effective_balance
            effectiveBalance = balanceString
            if let value = Double(balanceString) {
                isZeroBalance = value <= 0
                isLowBalance = value < 1.0
            }
        } catch {
            // Silently ignore errors — don't show error state in the popup
        }
    }
}
