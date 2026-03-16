import SwiftUI
import VellumAssistantShared

struct DrawerMenuView: View {
    let authManager: AuthManager
    let onSettings: () -> Void
    let onUsage: () -> Void
    let onDebug: () -> Void
    let onLogOut: () -> Void
    let onOpenBilling: () -> Void

    @State private var effectiveBalance: String?
    @State private var isLowBalance = false
    @State private var isZeroBalance = false

    private var isBillingVisible: Bool {
        authManager.isAuthenticated &&
        MacOSClientFeatureFlagManager.shared.isEnabled("settings_billing_enabled")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.xs) {
            DrawerThemeToggle()
                .padding(.horizontal, VSpacing.sm)

            VColor.surfaceBase.frame(height: 1)
                .padding(.vertical, VSpacing.xs)

            if let balance = effectiveBalance {
                HStack {
                    Text("$\(balance) remaining")
                        .font(VFont.bodyMedium)
                        .foregroundColor(
                            isZeroBalance ? VColor.systemNegativeStrong :
                            isLowBalance ? VColor.systemMidStrong :
                            VColor.contentDefault
                        )
                    Spacer()
                    if isBillingVisible {
                        Button("Add funds") { onOpenBilling() }
                            .font(VFont.captionMedium)
                            .foregroundColor(VColor.primaryBase)
                            .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, VSpacing.sm)

                VColor.surfaceBase.frame(height: 1)
                    .padding(.vertical, VSpacing.xs)
            }

            VStack(alignment: .leading, spacing: 0) {
                SidebarPrimaryRow(icon: VIcon.settings.rawValue, label: String(localized: "Settings"), action: onSettings)

                Text("Ask the assistant in chat to help you with any settings you wish to alter.")
                    .font(VFont.caption)
                    .foregroundColor(VColor.contentDisabled)
                    .padding(.horizontal, VSpacing.sm)
                    .padding(.top, VSpacing.xs)

                VColor.surfaceBase.frame(height: 1)
                    .padding(.vertical, VSpacing.sm)

                SidebarPrimaryRow(icon: VIcon.barChart.rawValue, label: String(localized: "Usage"), action: onUsage)

                SidebarPrimaryRow(icon: VIcon.bug.rawValue, label: "Debug", action: onDebug)

                SidebarPrimaryRow(icon: VIcon.logOut.rawValue, label: String(localized: "Log Out"), action: onLogOut)
            }
        }
        .padding(VSpacing.sm)
        .background(VColor.surfaceLift)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))
        .shadow(color: VColor.auxBlack.opacity(0.1), radius: 1.5, x: 0, y: 1)
        .shadow(color: VColor.auxBlack.opacity(0.1), radius: 6, x: 0, y: 4)
        .task {
            await loadBalance()
        }
    }

    private func loadBalance() async {
        guard authManager.isAuthenticated else { return }
        do {
            let summary = try await BillingService.shared.getBillingSummary()
            let balanceString = summary.effective_balance_usd
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
