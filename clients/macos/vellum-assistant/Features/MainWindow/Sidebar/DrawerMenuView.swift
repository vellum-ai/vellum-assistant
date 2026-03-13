import SwiftUI
import VellumAssistantShared

struct DrawerMenuView: View {
    let onSettings: () -> Void
    let onUsage: () -> Void
    let onDebug: () -> Void
    let onLogOut: () -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            DrawerThemeToggle()
                .padding(.horizontal, VSpacing.lg)
                .padding(.vertical, VSpacing.sm)

            VColor.borderBase.frame(height: 1)
                .padding(.vertical, VSpacing.xs)

            SidebarPrimaryRow(icon: VIcon.settings.rawValue, label: String(localized: "Settings"), action: onSettings)

            Text("Ask the assistant to help you with any settings you wish to change")
                .font(VFont.caption)
                .foregroundColor(VColor.contentSecondary)
                .padding(.horizontal, VSpacing.lg)
                .padding(.top, VSpacing.xs)
                .padding(.bottom, VSpacing.xs)

            VColor.borderBase.frame(height: 1)
                .padding(.vertical, VSpacing.xs)

            SidebarPrimaryRow(icon: VIcon.barChart.rawValue, label: String(localized: "Usage"), action: onUsage)

            SidebarPrimaryRow(icon: VIcon.bug.rawValue, label: "Debug", action: onDebug)

            SidebarPrimaryRow(icon: VIcon.logOut.rawValue, label: String(localized: "Log Out"), action: onLogOut)
        }
        .padding(.vertical, VSpacing.sm)
        .background(VColor.surfaceOverlay)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.lg)
                .stroke(VColor.borderBase, lineWidth: 1)
        )
        .shadow(color: VColor.auxBlack.opacity(0.15), radius: 6, y: -2)
    }
}
