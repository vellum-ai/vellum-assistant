import SwiftUI
import VellumAssistantShared

/// Three-way theme toggle for the control center drawer.
struct DrawerThemeToggle: View {
    @AppStorage("themePreference") private var themePreference: String = "system"

    private var themeBinding: Binding<String> {
        Binding(
            get: { themePreference },
            set: { themePreference = $0; VTheme.applyTheme($0) }
        )
    }

    var body: some View {
        HStack(spacing: VSpacing.xs) {
            Text("Theme")
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentDisabled)
            Spacer()
            VSegmentControl(
                items: [
                    (label: "System", icon: VIcon.monitor.rawValue, tag: "system"),
                    (label: "Light", icon: VIcon.sun.rawValue, tag: "light"),
                    (label: "Dark", icon: VIcon.moon.rawValue, tag: "dark"),
                ],
                selection: themeBinding
            )
            .frame(width: 104)
        }
    }
}
