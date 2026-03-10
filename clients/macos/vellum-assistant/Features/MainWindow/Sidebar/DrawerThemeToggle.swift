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
                .font(VFont.body)
                .foregroundColor(VColor.textPrimary)
            Spacer()
            HStack(spacing: 2) {
                ForEach(options, id: \.value) { option in
                    let isSelected = themePreference == option.value
                    Button {
                        themePreference = option.value
                        AppDelegate.shared?.applyThemePreference()
                    } label: {
                        VIconView(SFSymbolMapping.icon(forSFSymbol: option.icon, fallback: .puzzle), size: 12)
                            .foregroundColor(
                                isSelected
                                    ? VColor.buttonSecondaryText
                                    : VColor.textMuted
                            )
                            .frame(width: 30, height: 24)
                            .background(
                                isSelected
                                    ? VColor.themeToggleSelected
                                    : Color.clear
                            )
                            .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .pointerCursor()
                    .help(option.tooltip)
                    .accessibilityLabel("\(option.tooltip) theme")
                    .accessibilityValue(isSelected ? "Selected" : "")
                }
            }
            .padding(3)
            .background(VColor.themeToggleBackground)
            .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
        }
    }
}
