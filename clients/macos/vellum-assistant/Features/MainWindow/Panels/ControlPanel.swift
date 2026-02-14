import SwiftUI
import VellumAssistantShared

@MainActor
struct ControlPanel: View {
    var onClose: () -> Void
    var ambientAgent: AmbientAgent
    var daemonClient: DaemonClient?

    @State private var selectedTabIndex: Int = 1
    @State private var apiKeyText: String = ""
    @State private var hasKey: Bool = false
    @State private var braveKeyText: String = ""
    @State private var hasBraveKey: Bool = false
    @AppStorage("maxStepsPerSession") private var maxSteps: Double = 50
    @AppStorage("ambientAgentEnabled") private var ambientEnabled: Bool = false
    @State private var showingTrustRules = false

    private enum ControlTab: String, CaseIterable {
        case profile, settings, channels, overview
    }

    private var selectedTab: ControlTab {
        ControlTab.allCases.indices.contains(selectedTabIndex)
            ? ControlTab.allCases[selectedTabIndex]
            : .settings
    }

    var body: some View {
        VSidePanel(title: "Control", onClose: onClose, pinnedContent: {
            VSegmentedControl(
                items: ControlTab.allCases.map { $0.rawValue.capitalized },
                selection: $selectedTabIndex
            )
            .padding(.top, VSpacing.sm)

            Divider().background(VColor.surfaceBorder)
        }) {
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
        .onAppear {
            refreshAPIKeyState()
        }
        .onReceive(NotificationCenter.default.publisher(for: .apiKeyManagerDidChange)) { _ in
            refreshAPIKeyState()
        }
    }

    // MARK: - Settings Content

    private var settingsContent: some View {
        VStack(alignment: .leading, spacing: VSpacing.xl) {
            // ANTHROPIC section
            VStack(alignment: .leading, spacing: VSpacing.md) {
                Text("ANTHROPIC")
                    .font(VFont.sectionTitle)
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
                        .textFieldStyle(.plain)
                        .font(VFont.body)
                        .foregroundColor(VColor.textPrimary)
                        .padding(VSpacing.md)
                        .background(VColor.surface)
                        .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
                        .overlay(
                            RoundedRectangle(cornerRadius: VRadius.md)
                                .stroke(VColor.surfaceBorder.opacity(0.5), lineWidth: 1)
                        )

                    Text("Get your API key at console.anthropic.com")
                        .font(VFont.caption)
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
            .vCard(background: Slate._900)

            // BRAVE SEARCH section
            VStack(alignment: .leading, spacing: VSpacing.md) {
                Text("BRAVE SEARCH")
                    .font(VFont.sectionTitle)
                    .foregroundColor(VColor.textPrimary)

                if hasBraveKey {
                    HStack {
                        Text("BSA...configured")
                            .font(VFont.body)
                            .foregroundColor(VColor.textSecondary)
                        Spacer()
                        VButton(label: "Clear", style: .danger) {
                            APIKeyManager.deleteKey(for: "brave")
                            hasBraveKey = false
                            braveKeyText = ""
                        }
                    }
                } else {
                    HStack(spacing: VSpacing.xs) {
                        Text("Enter Brave Search API Key")
                            .font(VFont.caption)
                            .foregroundColor(VColor.textSecondary)
                        Image(systemName: "info.circle")
                            .font(.system(size: 12))
                            .foregroundColor(VColor.textMuted)
                    }

                    SecureField("Your Brave Search API key", text: $braveKeyText)
                        .textFieldStyle(.plain)
                        .font(VFont.body)
                        .foregroundColor(VColor.textPrimary)
                        .padding(VSpacing.md)
                        .background(VColor.surface)
                        .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
                        .overlay(
                            RoundedRectangle(cornerRadius: VRadius.md)
                                .stroke(VColor.surfaceBorder.opacity(0.5), lineWidth: 1)
                        )

                    Text("Get your API key at brave.com/search/api")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)

                    VButton(label: "Save", style: .primary) {
                        let trimmed = braveKeyText.trimmingCharacters(in: .whitespacesAndNewlines)
                        guard !trimmed.isEmpty else { return }
                        APIKeyManager.setKey(trimmed, for: "brave")
                        hasBraveKey = true
                        braveKeyText = ""
                    }
                }
            }
            .padding(VSpacing.lg)
            .vCard(background: Slate._900)

            // COMPUTER USAGE section
            VStack(alignment: .leading, spacing: VSpacing.md) {
                Text("COMPUTER USAGE")
                    .font(VFont.sectionTitle)
                    .foregroundColor(VColor.textPrimary)

                HStack {
                    Text("Max Steps per Session")
                        .font(VFont.body)
                        .foregroundColor(VColor.textSecondary)
                    Image(systemName: "info.circle")
                        .font(.system(size: 12))
                        .foregroundColor(VColor.textMuted)
                    Spacer()
                    Text("\(Int(maxSteps))")
                        .font(VFont.mono)
                        .foregroundColor(VColor.textSecondary)
                }

                VSlider(value: $maxSteps, range: 1...100, step: 10, showTickMarks: true)
            }
            .padding(VSpacing.lg)
            .vCard(background: Slate._900)

            // AMBIENT AGENT section
            VStack(alignment: .leading, spacing: VSpacing.md) {
                Text("AMBIENT AGENT")
                    .font(VFont.sectionTitle)
                    .foregroundColor(VColor.textPrimary)

                HStack {
                    Text("Enable ambient screen watching")
                        .font(VFont.body)
                        .foregroundColor(VColor.textSecondary)
                    Image(systemName: "info.circle")
                        .font(.system(size: 12))
                        .foregroundColor(VColor.textMuted)
                    Spacer()
                    VToggle(isOn: $ambientEnabled)
                }
                .onChange(of: ambientEnabled) { _, newValue in
                    ambientAgent.isEnabled = newValue
                }
            }
            .padding(VSpacing.lg)
            .vCard(background: Slate._900)

            // PERMISSIONS section
            VStack(alignment: .leading, spacing: VSpacing.md) {
                Text("PERMISSIONS")
                    .font(VFont.sectionTitle)
                    .foregroundColor(VColor.textPrimary)

                permissionRow(
                    emoji: "\u{1F47B}",
                    label: "Accessibility",
                    granted: PermissionManager.accessibilityStatus() == .granted
                )
                .padding(VSpacing.md)
                .vCard(background: Slate._900)

                permissionRow(
                    emoji: "\u{1F355}",
                    label: "Screen Recording",
                    granted: PermissionManager.screenRecordingStatus() == .granted
                )
                .padding(VSpacing.md)
                .vCard(background: Slate._900)
            }
            .padding(VSpacing.lg)
            .vCard(background: Slate._900)

            // TRUST RULES section
            if let daemonClient {
                VStack(alignment: .leading, spacing: VSpacing.md) {
                    Text("TRUST RULES")
                        .font(VFont.sectionTitle)
                        .foregroundColor(VColor.textPrimary)

                    HStack {
                        VStack(alignment: .leading, spacing: VSpacing.xs) {
                            Text("Manage Trust Rules")
                                .font(VFont.body)
                                .foregroundColor(VColor.textSecondary)
                            Text("Control which tool actions are automatically allowed or denied")
                                .font(VFont.caption)
                                .foregroundColor(VColor.textMuted)
                        }
                        Spacer()
                        VButton(label: "Manage...", style: .ghost) {
                            showingTrustRules = true
                        }
                    }
                }
                .padding(VSpacing.lg)
                .vCard(background: Slate._900)
                .sheet(isPresented: $showingTrustRules) {
                    TrustRulesView(daemonClient: daemonClient)
                }
            }

            // PRIVACY & SECURITY section
            VStack(alignment: .leading, spacing: VSpacing.md) {
                Text("PRIVACY & SECURITY")
                    .font(VFont.sectionTitle)
                    .foregroundColor(VColor.textPrimary)

                VStack(alignment: .leading, spacing: 0) {
                    privacyBullet(icon: "eye.slash", text: "AI only runs when you trigger it or enable ambient mode")
                    Divider().background(VColor.surfaceBorder)
                    privacyBullet(icon: "lock.shield", text: "API key stored in macOS Keychain")
                    Divider().background(VColor.surfaceBorder)
                    privacyBullet(icon: "xmark.shield", text: "Your data is not used to train AI models")
                    Divider().background(VColor.surfaceBorder)
                    privacyBullet(icon: "internaldrive", text: "Session logs and knowledge stored locally on your Mac")
                }
            }
            .padding(VSpacing.lg)
            .vCard(background: Slate._900)
        }
    }

    // MARK: - Permission Row

    private func permissionRow(emoji: String, label: String, granted: Bool) -> some View {
        HStack(spacing: VSpacing.md) {
            Text(emoji)
                .font(.system(size: 14))
                .frame(width: 20)
                .accessibilityLabel(label)

            Text(label)
                .font(VFont.body)
                .foregroundColor(VColor.textPrimary)

            Spacer()

            Image(systemName: granted ? "checkmark.circle.fill" : "xmark.circle.fill")
                .font(.system(size: 16))
                .foregroundColor(granted ? VColor.success : VColor.error)
        }
    }

    // MARK: - Privacy Bullet

    private func privacyBullet(icon: String, text: String) -> some View {
        HStack(alignment: .top, spacing: VSpacing.sm) {
            Image(systemName: icon)
                .font(.system(size: 12))
                .foregroundColor(VColor.textMuted)
                .frame(width: 16)
            Text(text)
                .font(VFont.caption)
                .foregroundColor(VColor.textSecondary)
        }
        .padding(.vertical, VSpacing.md)
    }

    private func refreshAPIKeyState() {
        hasKey = APIKeyManager.getKey() != nil
        hasBraveKey = APIKeyManager.getKey(for: "brave") != nil
    }

}

#Preview("ControlPanel") {
    ZStack {
        VColor.background.ignoresSafeArea()
        ControlPanel(onClose: {}, ambientAgent: AmbientAgent())
    }
    .frame(width: 600, height: 700)
}
