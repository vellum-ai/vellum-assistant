import SwiftUI

struct ControlPanel: View {
    var onClose: () -> Void
    var ambientAgent: AmbientAgent

    @State private var selectedTab: ControlTab = .settings
    @State private var apiKeyText: String = ""
    @State private var hasKey: Bool = false
    @AppStorage("maxStepsPerSession") private var maxSteps: Double = 50
    @AppStorage("ambientAgentEnabled") private var ambientEnabled: Bool = false

    private enum ControlTab: String, CaseIterable {
        case profile, settings, channels, overview
    }

    var body: some View {
        VSidePanel(title: "Control", onClose: onClose) {
            HStack(alignment: .top, spacing: 0) {
                // Left nav
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    ForEach(ControlTab.allCases, id: \.self) { tab in
                        navButton(tab.rawValue.capitalized, selected: selectedTab == tab) {
                            selectedTab = tab
                        }
                    }
                }
                .frame(width: 100)
                .padding(.top, VSpacing.md)

                Divider()

                // Right content
                ScrollView {
                    Group {
                        switch selectedTab {
                        case .settings:
                            settingsContent
                        case .profile:
                            VEmptyState(
                                title: "Profile",
                                subtitle: "User profile coming soon",
                                icon: "person.circle"
                            )
                        case .channels:
                            VEmptyState(
                                title: "Channels",
                                subtitle: "Channel configuration coming soon",
                                icon: "antenna.radiowaves.left.and.right"
                            )
                        case .overview:
                            VEmptyState(
                                title: "Overview",
                                subtitle: "System overview coming soon",
                                icon: "chart.bar"
                            )
                        }
                    }
                    .padding(VSpacing.lg)
                }
            }
        }
        .onAppear {
            hasKey = APIKeyManager.getKey() != nil
        }
    }

    // MARK: - Nav Button

    private func navButton(_ title: String, selected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(VFont.bodyMedium)
                .foregroundColor(selected ? VColor.textPrimary : VColor.textSecondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, VSpacing.sm)
                .padding(.vertical, VSpacing.xs)
        }
        .buttonStyle(.plain)
        .background(selected ? VColor.surface : Color.clear)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
        .vHover()
    }

    // MARK: - Settings Content

    private var settingsContent: some View {
        VStack(alignment: .leading, spacing: VSpacing.xl) {
            // ANTHROPIC section
            VStack(alignment: .leading, spacing: VSpacing.md) {
                Text("ANTHROPIC")
                    .font(VFont.display)
                    .foregroundColor(VColor.textPrimary)

                if hasKey {
                    HStack {
                        Text("sk-ant-...configured")
                            .font(VFont.body)
                            .foregroundColor(VColor.textSecondary)
                        Spacer()
                        VButton(label: "Clear", style: .danger) {
                            APIKeyManager.deleteKey()
                            hasKey = false
                            apiKeyText = ""
                        }
                    }
                } else {
                    HStack(spacing: VSpacing.xs) {
                        Text("Enter API Key")
                            .font(VFont.caption)
                            .foregroundColor(VColor.textSecondary)
                        Image(systemName: "info.circle")
                            .font(.system(size: 12))
                            .foregroundColor(VColor.textMuted)
                    }

                    SecureField("This is your private generated key", text: $apiKeyText)
                        .textFieldStyle(.roundedBorder)

                    Text("Get your API key at console.anthropic.com")
                        .font(VFont.small)
                        .foregroundColor(VColor.textMuted)

                    VButton(label: "Save", style: .primary) {
                        let trimmed = apiKeyText.trimmingCharacters(in: .whitespacesAndNewlines)
                        guard !trimmed.isEmpty else { return }
                        APIKeyManager.setKey(trimmed)
                        hasKey = true
                        apiKeyText = ""
                    }
                }
            }
            .padding(VSpacing.lg)
            .vCard()

            // COMPUTER USAGE section
            VStack(alignment: .leading, spacing: VSpacing.md) {
                Text("COMPUTER USAGE")
                    .font(VFont.display)
                    .foregroundColor(VColor.textPrimary)

                HStack {
                    Text("Max Steps per Session")
                        .font(VFont.body)
                        .foregroundColor(VColor.textPrimary)
                    Image(systemName: "info.circle")
                        .font(.system(size: 12))
                        .foregroundColor(VColor.textMuted)
                    Spacer()
                    Text("\(Int(maxSteps))")
                        .font(VFont.mono)
                        .foregroundColor(VColor.textSecondary)
                }

                Slider(value: $maxSteps, in: 1...100, step: 1)
                    .tint(VColor.accent)
            }
            .padding(VSpacing.lg)
            .vCard()

            // AMBIENT AGENT section
            VStack(alignment: .leading, spacing: VSpacing.md) {
                Text("AMBIENT AGENT")
                    .font(VFont.display)
                    .foregroundColor(VColor.textPrimary)

                Toggle(isOn: $ambientEnabled) {
                    HStack(spacing: VSpacing.xs) {
                        Text("Enable ambient screen watching")
                        Image(systemName: "info.circle")
                            .font(.system(size: 12))
                            .foregroundColor(VColor.textMuted)
                    }
                }
                .tint(VColor.accent)
                .font(VFont.body)
                .foregroundColor(VColor.textPrimary)
                .onChange(of: ambientEnabled) { _, newValue in
                    ambientAgent.isEnabled = newValue
                }
            }
            .padding(VSpacing.lg)
            .vCard()

            // PERMISSIONS section
            VStack(alignment: .leading, spacing: VSpacing.md) {
                Text("PERMISSIONS")
                    .font(VFont.display)
                    .foregroundColor(VColor.textPrimary)

                permissionRow(
                    emoji: "\u{1F47B}",
                    label: "Accessibility",
                    granted: PermissionManager.accessibilityStatus() == .granted
                )

                permissionRow(
                    icon: "record.circle",
                    label: "Screen Recording",
                    granted: PermissionManager.screenRecordingStatus() == .granted
                )

                permissionRow(
                    icon: "key",
                    label: "API Key",
                    granted: APIKeyManager.getKey() != nil
                )
            }
            .padding(VSpacing.lg)
            .vCard()
        }
    }

    // MARK: - Permission Row

    private func permissionRow(icon: String, label: String, granted: Bool) -> some View {
        HStack(spacing: VSpacing.md) {
            Image(systemName: icon)
                .font(.system(size: 14))
                .foregroundColor(VColor.textSecondary)
                .frame(width: 20)

            Text(label)
                .font(VFont.body)
                .foregroundColor(VColor.textPrimary)

            Spacer()

            Image(systemName: granted ? "checkmark.circle.fill" : "xmark.circle.fill")
                .font(.system(size: 16))
                .foregroundColor(granted ? VColor.success : VColor.error)
        }
    }

    private func permissionRow(emoji: String, label: String, granted: Bool) -> some View {
        HStack(spacing: VSpacing.md) {
            Text(emoji)
                .font(.system(size: 14))
                .frame(width: 20)

            Text(label)
                .font(VFont.body)
                .foregroundColor(VColor.textPrimary)

            Spacer()

            Image(systemName: granted ? "checkmark.circle.fill" : "xmark.circle.fill")
                .font(.system(size: 16))
                .foregroundColor(granted ? VColor.success : VColor.error)
        }
    }

}

#Preview("ControlPanel") {
    ZStack {
        VColor.background.ignoresSafeArea()
        ControlPanel(onClose: {}, ambientAgent: AmbientAgent())
    }
    .frame(width: 600, height: 700)
}
