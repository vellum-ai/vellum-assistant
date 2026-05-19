import SwiftUI
import VellumAssistantShared

struct DrawerMenuView: View {
    let authManager: AuthManager
    let onSettings: () -> Void
    let onLogsAndUsage: () -> Void
    let onShareFeedback: () -> Void
    let onLogOut: () -> Void
    let onSignIn: () -> Void

    var body: some View {
        VMenu {
            VMenuCustomRow {
                DrawerThemeToggle()
            }

            VMenuCustomRow {
                tightDividerLine
            }

            VMenuItem(icon: VIcon.settings.rawValue, label: String(localized: "Settings"), action: onSettings)

            VMenuItem(icon: VIcon.barChart.rawValue, label: String(localized: "Usage"), action: onLogsAndUsage)
            VMenuItem(icon: VIcon.messageCircle.rawValue, label: String(localized: "Share Feedback"), action: onShareFeedback)

            if authManager.isAuthenticated {
                VMenuItem(icon: VIcon.logOut.rawValue, label: String(localized: "Log Out"), action: onLogOut)
            } else {
                VMenuItem(icon: VIcon.logOut.rawValue, label: String(localized: "Log In"), action: onSignIn)
            }
        }
    }

    /// 1pt divider line without VMenuDivider's 4pt vertical padding,
    /// used for sections that should sit tight against neighboring rows.
    private var tightDividerLine: some View {
        Rectangle()
            .fill(VColor.borderOverlay)
            .frame(height: 1)
    }
}
