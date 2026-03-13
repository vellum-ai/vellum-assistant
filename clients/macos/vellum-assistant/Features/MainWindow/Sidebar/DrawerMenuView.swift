import SwiftUI
import VellumAssistantShared

struct DrawerMenuView: View {
    let onSettings: () -> Void
    let onUsage: () -> Void
    let onDebug: () -> Void
    let onLogOut: () -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.xs) {
            DrawerThemeToggle()
                .padding(.horizontal, VSpacing.sm)

            VColor.surfaceBase.frame(height: 1)
                .padding(.vertical, VSpacing.xs)

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
    }
}
