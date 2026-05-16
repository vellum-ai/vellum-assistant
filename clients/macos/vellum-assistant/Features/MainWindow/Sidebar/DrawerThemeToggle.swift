import SwiftUI
import VellumAssistantShared

/// Theme toggle for the control center drawer. Shows three options (System/Light/Dark)
/// by default, plus a fourth Velvet option when the velvet-theme feature flag is enabled.
struct DrawerThemeToggle: View {
    @AppStorage("themePreference") private var themePreference: String = "system"

    private var themeBinding: Binding<String> {
        Binding(
            get: { themePreference },
            set: { themePreference = $0; VTheme.applyTheme($0) }
        )
    }

    private var isVelvetEnabled: Bool {
        MacOSClientFeatureFlagManager.shared.isEnabled("velvet-theme")
    }

    var body: some View {
        HStack(spacing: VSpacing.xs) {
            Text("Theme")
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentDisabled)
            Spacer()
            VSegmentControl(
                items: isVelvetEnabled
                    ? [
                        (label: "System", icon: VIcon.monitor.rawValue, tag: "system"),
                        (label: "Light", icon: VIcon.sun.rawValue, tag: "light"),
                        (label: "Dark", icon: VIcon.moon.rawValue, tag: "dark"),
                        (label: "Velvet", icon: VIcon.sparkle.rawValue, tag: "velvet"),
                    ]
                    : [
                        (label: "System", icon: VIcon.monitor.rawValue, tag: "system"),
                        (label: "Light", icon: VIcon.sun.rawValue, tag: "light"),
                        (label: "Dark", icon: VIcon.moon.rawValue, tag: "dark"),
                    ],
                selection: themeBinding
            )
            .frame(width: isVelvetEnabled ? 140 : 104)
        }
    }
}
