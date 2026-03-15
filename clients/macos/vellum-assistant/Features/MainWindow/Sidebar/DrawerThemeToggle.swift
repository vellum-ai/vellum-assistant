import SwiftUI
import VellumAssistantShared

/// Compact three-way theme toggle (System / Light / Dark) for the control center drawer.
struct DrawerThemeToggle: View {
    @AppStorage("themePreference") private var themePreference: String = "system"

    var body: some View {
        HStack(spacing: VSpacing.xs) {
            Text("Theme")
                .font(VFont.caption)
                .foregroundColor(VColor.contentDisabled)
            Spacer()
            VSegmentedControl(
                items: [
                    (label: "System", icon: VIcon.monitor.rawValue, tag: "system"),
                    (label: "Light", icon: VIcon.sun.rawValue, tag: "light"),
                    (label: "Dark", icon: VIcon.moon.rawValue, tag: "dark"),
                ],
                selection: Binding(
                    get: { themePreference },
                    set: {
                        themePreference = $0
                        AppDelegate.shared?.applyThemePreference()
                    }
                ),
                style: .pill
            )
            .fixedSize()
        }
    }
}
