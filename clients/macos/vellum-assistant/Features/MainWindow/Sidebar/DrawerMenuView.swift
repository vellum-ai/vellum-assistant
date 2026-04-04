import SwiftUI
import VellumAssistantShared

struct DrawerMenuView: View {
    let authManager: AuthManager
    let onSettings: () -> Void
    let onUsage: () -> Void
    let onDebug: () -> Void
    let onLogOut: () -> Void
    let onSignIn: () -> Void
    let onOpenBilling: () -> Void

    @State private var effectiveBalance: String?
    @State private var isLowBalance = false
    @State private var isZeroBalance = false
    @State private var bootstrapGeneration: Int = 0
    @AppStorage("connectedOrganizationId") private var connectedOrgId: String?

    private var isBillingVisible: Bool {
        let _ = bootstrapGeneration  // Force recomputation when bootstrap completes
        return authManager.isAuthenticated &&
        MacOSClientFeatureFlagManager.shared.isEnabled("settings-billing") &&
        connectedOrgId != nil
    }

    var body: some View {
        VMenu {
            VMenuCustomRow {
                DrawerThemeToggle()
            }

            VMenuDivider()

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
                }

                VMenuDivider()
            }

            VMenuItem(icon: VIcon.settings.rawValue, label: String(localized: "Settings"), action: onSettings)

            VMenuCustomRow {
                Text("Ask the assistant in chat to help you with any settings you wish to alter.")
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentDisabled)
                    .padding(.top, VSpacing.xs)
            }

            VMenuDivider()

            VMenuItem(icon: VIcon.barChart.rawValue, label: String(localized: "Usage"), action: onUsage)
            VMenuItem(icon: VIcon.scrollText.rawValue, label: String(localized: "Logs"), action: onDebug)

            if authManager.isAuthenticated {
                VMenuItem(icon: VIcon.logOut.rawValue, label: String(localized: "Log Out"), action: onLogOut)
            } else {
                VMenuItem(icon: VIcon.logOut.rawValue, label: String(localized: "Log In"), action: onSignIn)
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .localBootstrapCompleted)) { _ in
            bootstrapGeneration += 1
        }
        .task {
            await loadBalance()
        }
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
