import SwiftUI
import VellumAssistantShared

/// Compact three-way theme toggle (System / Light / Dark) for the control center drawer.
struct DrawerThemeToggle: View {
    @AppStorage("themePreference") private var themePreference: String = "system"

    private struct ThemeOption {
        let value: String
        let icon: String
        let tooltip: String
    }

    private let options: [ThemeOption] = [
        ThemeOption(value: "system", icon: "circle.lefthalf.filled", tooltip: "System"),
        ThemeOption(value: "light", icon: "sun.max.fill", tooltip: "Light"),
        ThemeOption(value: "dark", icon: "moon.fill", tooltip: "Dark"),
    ]

    var body: some View {
        HStack(spacing: VSpacing.xs) {
            Text("Theme")
                .font(VFont.caption)
                .foregroundColor(VColor.textSecondary)
            Spacer()
            HStack(spacing: 2) {
                ForEach(options, id: \.value) { option in
                    let isSelected = themePreference == option.value
                    Button {
                        themePreference = option.value
                        AppDelegate.shared?.applyThemePreference()
                    } label: {
                        Image(systemName: option.icon)
                            .font(.system(size: 11, weight: .medium))
                            .foregroundColor(isSelected ? VColor.textPrimary : VColor.textMuted)
                            .frame(width: 28, height: 22)
                            .background(
                                isSelected
                                    ? VColor.hoverOverlay.opacity(0.1)
                                    : Color.clear
                            )
                            .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
                    }
                    .buttonStyle(.plain)
                    .help(option.tooltip)
                    .accessibilityLabel("\(option.tooltip) theme")
                    .accessibilityValue(isSelected ? "Selected" : "")
                }
            }
            .padding(2)
            .background(VColor.surface)
            .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
            .overlay(
                RoundedRectangle(cornerRadius: VRadius.md)
                    .stroke(VColor.surfaceBorder, lineWidth: 1)
            )
        }
    }
}
