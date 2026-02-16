import SwiftUI
import VellumAssistantShared

@MainActor
struct SettingsPanel: View {
    var onClose: () -> Void
    @ObservedObject var store: SettingsStore
    var daemonClient: DaemonClient?
    @ObservedObject var threadManager: ThreadManager

    @State private var apiKeyText: String = ""
    @State private var braveKeyText: String = ""
    @State private var showingTrustRules = false
    @State private var showingScheduledTasks = false
    @State private var showingReminders = false
    @State private var integrations: [IPCIntegrationListResponseIntegration] = []
    @State private var connectingIntegration: String?
    @AppStorage("useThreadDrawer") private var useThreadDrawer: Bool = false
    @AppStorage("themePreference") private var themePreference: String = "system"

    var body: some View {
        VSidePanel(title: "Settings", onClose: onClose) {
            VStack(alignment: .leading, spacing: VSpacing.xl) {
                // ANTHROPIC section
                VStack(alignment: .leading, spacing: VSpacing.md) {
                    Text("ANTHROPIC")
                        .font(VFont.sectionTitle)
                        .foregroundColor(VColor.textPrimary)

                    if store.hasKey {
                        HStack {
                            Text("sk-ant-...configured")
                                .font(VFont.body)
                                .foregroundColor(VColor.textSecondary)
                            Spacer()
                            VButton(label: "Clear", style: .danger) {
                                store.clearAPIKey()
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
                            store.saveAPIKey(apiKeyText)
                            apiKeyText = ""
                        }
                    }
                }
                .padding(VSpacing.lg)
                .vCard(background: VColor.surfaceSubtle)

                // BRAVE SEARCH section
                VStack(alignment: .leading, spacing: VSpacing.md) {
                    Text("BRAVE SEARCH")
                        .font(VFont.sectionTitle)
                        .foregroundColor(VColor.textPrimary)

                    if store.hasBraveKey {
                        HStack {
                            Text("BSA...configured")
                                .font(VFont.body)
                                .foregroundColor(VColor.textSecondary)
                            Spacer()
                            VButton(label: "Clear", style: .danger) {
                                store.clearBraveKey()
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
                            store.saveBraveKey(braveKeyText)
                            braveKeyText = ""
                        }
                    }
                }
                .padding(VSpacing.lg)
                .vCard(background: VColor.surfaceSubtle)

                // INTEGRATIONS section
                if daemonClient != nil {
                    VStack(alignment: .leading, spacing: VSpacing.md) {
                        Text("INTEGRATIONS")
                            .font(VFont.sectionTitle)
                            .foregroundColor(VColor.textPrimary)

                        if integrations.isEmpty {
                            Text("No integrations available")
                                .font(VFont.caption)
                                .foregroundColor(VColor.textMuted)
                        } else {
                            ForEach(integrations, id: \.id) { integration in
                                integrationRow(integration)
                            }
                        }
                    }
                    .padding(VSpacing.lg)
                    .vCard(background: VColor.surfaceSubtle)
                }

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
                        Text("\(Int(store.maxSteps))")
                            .font(VFont.mono)
                            .foregroundColor(VColor.textSecondary)
                    }

                    VSlider(value: $store.maxSteps, range: 1...100, step: 10, showTickMarks: true)
                }
                .padding(VSpacing.lg)
                .vCard(background: VColor.surfaceSubtle)

                // RIDE SHOTGUN section
                VStack(alignment: .leading, spacing: VSpacing.md) {
                    Text("RIDE SHOTGUN")
                        .font(VFont.sectionTitle)
                        .foregroundColor(VColor.textPrimary)

                    Text("Ride Shotgun lets the assistant watch how you work for a few minutes, then offers to help based on what it observed.")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)

                    Text("Use the menu bar icon or wait for the assistant to offer.")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)
                }
                .padding(VSpacing.lg)
                .vCard(background: VColor.surfaceSubtle)

                // DISPLAY section
                VStack(alignment: .leading, spacing: VSpacing.md) {
                    Text("DISPLAY")
                        .font(VFont.sectionTitle)
                        .foregroundColor(VColor.textPrimary)

                    HStack {
                        Text("Theme")
                            .font(VFont.body)
                            .foregroundColor(VColor.textSecondary)
                        Spacer()
                        Picker("", selection: Binding(
                            get: { themePreference },
                            set: { newValue in
                                themePreference = newValue
                                UserDefaults.standard.set(newValue, forKey: "themePreference")
                                UserDefaults.standard.synchronize()
                                if let delegate = NSApp.delegate as? AppDelegate {
                                    delegate.applyThemePreference()
                                }
                            }
                        )) {
                            Text("System").tag("system")
                            Text("Light").tag("light")
                            Text("Dark").tag("dark")
                        }
                        .pickerStyle(.segmented)
                        .frame(width: 200)
                    }

                    HStack {
                        VStack(alignment: .leading, spacing: VSpacing.xs) {
                            Text("Show thread list drawer")
                                .font(VFont.body)
                                .foregroundColor(VColor.textSecondary)
                            Text("Access chat history from a left-side drawer instead of tabs")
                                .font(VFont.caption)
                                .foregroundColor(VColor.textMuted)
                        }
                        Spacer()
                        VToggle(isOn: $useThreadDrawer)
                    }
                }
                .padding(VSpacing.lg)
                .vCard(background: VColor.surfaceSubtle)

                // ARCHIVED THREADS section
                if !threadManager.archivedThreads.isEmpty {
                    VStack(alignment: .leading, spacing: VSpacing.md) {
                        Text("ARCHIVED THREADS")
                            .font(VFont.sectionTitle)
                            .foregroundColor(VColor.textPrimary)

                        ForEach(threadManager.archivedThreads) { thread in
                            HStack {
                                Text(thread.title)
                                    .font(VFont.body)
                                    .foregroundColor(VColor.textSecondary)
                                    .lineLimit(1)
                                Spacer()
                                Button(action: { threadManager.unarchiveThread(id: thread.id) }) {
                                    Text("Unarchive")
                                        .font(VFont.caption)
                                        .foregroundColor(VColor.accent)
                                }
                                .buttonStyle(.plain)
                                .accessibilityLabel("Unarchive \(thread.title)")
                            }
                            .padding(.vertical, VSpacing.xs)
                        }
                    }
                    .padding(VSpacing.lg)
                    .vCard(background: VColor.surfaceSubtle)
                }

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
                    .vCard(background: VColor.surfaceSubtle)

                    permissionRow(
                        emoji: "\u{1F355}",
                        label: "Screen Recording",
                        granted: PermissionManager.screenRecordingStatus() == .granted
                    )
                    .padding(VSpacing.md)
                    .vCard(background: VColor.surfaceSubtle)
                }
                .padding(VSpacing.lg)
                .vCard(background: VColor.surfaceSubtle)

                // SCHEDULED TASKS section
                if daemonClient != nil {
                    VStack(alignment: .leading, spacing: VSpacing.md) {
                        Text("SCHEDULED TASKS")
                            .font(VFont.sectionTitle)
                            .foregroundColor(VColor.textPrimary)

                        HStack {
                            VStack(alignment: .leading, spacing: VSpacing.xs) {
                                Text("Manage Scheduled Tasks")
                                    .font(VFont.body)
                                    .foregroundColor(VColor.textSecondary)
                                Text("View and manage recurring tasks created by the assistant")
                                    .font(VFont.caption)
                                    .foregroundColor(VColor.textMuted)
                            }
                            Spacer()
                            VButton(label: "Manage...", style: .ghost) {
                                showingScheduledTasks = true
                            }
                        }
                    }
                    .padding(VSpacing.lg)
                    .vCard(background: VColor.surfaceSubtle)
                }

                // REMINDERS section
                if daemonClient != nil {
                    VStack(alignment: .leading, spacing: VSpacing.md) {
                        Text("REMINDERS")
                            .font(VFont.sectionTitle)
                            .foregroundColor(VColor.textPrimary)

                        HStack {
                            VStack(alignment: .leading, spacing: VSpacing.xs) {
                                Text("Manage Reminders")
                                    .font(VFont.body)
                                    .foregroundColor(VColor.textSecondary)
                                Text("View and manage one-shot reminders created by the assistant")
                                    .font(VFont.caption)
                                    .foregroundColor(VColor.textMuted)
                            }
                            Spacer()
                            VButton(label: "Manage...", style: .ghost) {
                                showingReminders = true
                            }
                        }
                    }
                    .padding(VSpacing.lg)
                    .vCard(background: VColor.surfaceSubtle)
                }

                // TRUST RULES section
                if daemonClient != nil {
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
                                daemonClient?.isTrustRulesSheetOpen = true
                                showingTrustRules = true
                            }
                            .disabled(store.isAnyTrustRulesSheetOpen)
                        }
                    }
                    .padding(VSpacing.lg)
                    .vCard(background: VColor.surfaceSubtle)
                }

                // PRIVACY & SECURITY section
                VStack(alignment: .leading, spacing: VSpacing.md) {
                    Text("PRIVACY & SECURITY")
                        .font(VFont.sectionTitle)
                        .foregroundColor(VColor.textPrimary)

                    VStack(alignment: .leading, spacing: 0) {
                        privacyBullet(icon: "eye.slash", text: "AI only runs when you trigger it or enable Ride Shotgun sessions")
                        Divider().background(VColor.surfaceBorder)
                        privacyBullet(icon: "lock.shield", text: "API key stored in macOS Keychain")
                        Divider().background(VColor.surfaceBorder)
                        privacyBullet(icon: "xmark.shield", text: "Your data is not used to train AI models")
                        Divider().background(VColor.surfaceBorder)
                        privacyBullet(icon: "internaldrive", text: "Session logs and knowledge stored locally on your Mac")
                    }
                }
                .padding(VSpacing.lg)
                .vCard(background: VColor.surfaceSubtle)
            }
        }
        .onAppear {
            store.refreshAPIKeyState()
            setupIntegrationCallbacks()
            try? daemonClient?.sendIntegrationList()
        }
        .onDisappear {
            daemonClient?.onIntegrationListResponse = nil
            daemonClient?.onIntegrationConnectResult = nil
        }
        .sheet(isPresented: $showingTrustRules) {
            if let daemonClient {
                TrustRulesView(daemonClient: daemonClient)
            }
        }
        .sheet(isPresented: $showingScheduledTasks) {
            if let daemonClient {
                ScheduledTasksView(daemonClient: daemonClient)
            }
        }
        .sheet(isPresented: $showingReminders) {
            if let daemonClient {
                RemindersView(daemonClient: daemonClient)
            }
        }
    }

    // MARK: - Integration Row

    private func integrationRow(_ integration: IPCIntegrationListResponseIntegration) -> some View {
        HStack(spacing: VSpacing.md) {
            Text(integrationIcon(integration.id))
                .font(.system(size: 14))
                .frame(width: 20)

            VStack(alignment: .leading, spacing: 2) {
                Text(integrationDisplayName(integration.id))
                    .font(VFont.body)
                    .foregroundColor(VColor.textPrimary)
                if let account = integration.accountInfo {
                    Text(account)
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)
                }
            }

            Spacer()

            if integration.connected {
                Image(systemName: "checkmark.circle.fill")
                    .foregroundColor(VColor.success)
                    .font(.system(size: 14))
                VButton(label: "Disconnect", style: .danger) {
                    try? daemonClient?.sendIntegrationDisconnect(integrationId: integration.id)
                }
            } else {
                if connectingIntegration == integration.id {
                    ProgressView()
                        .controlSize(.small)
                } else {
                    VButton(label: "Connect", style: .primary) {
                        connectingIntegration = integration.id
                        do {
                            try daemonClient?.sendIntegrationConnect(integrationId: integration.id)
                        } catch {
                            connectingIntegration = nil
                        }
                    }
                }
            }
        }
        .padding(VSpacing.md)
        .vCard(background: VColor.surfaceSubtle)
    }

    private func integrationDisplayName(_ id: String) -> String {
        switch id {
        case "gmail": return "Gmail"
        default: return id.capitalized
        }
    }

    private func integrationIcon(_ id: String) -> String {
        switch id {
        case "gmail": return "\u{1F4E7}"
        default: return "\u{1F517}"
        }
    }

    private func setupIntegrationCallbacks() {
        daemonClient?.onIntegrationListResponse = { [self] response in
            Task { @MainActor in
                self.integrations = response.integrations
            }
        }
        daemonClient?.onIntegrationConnectResult = { [self] result in
            Task { @MainActor in
                self.connectingIntegration = nil
                // Refresh the list after connect/disconnect
                try? self.daemonClient?.sendIntegrationList()
            }
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

}

#Preview("SettingsPanel") {
    let dc = DaemonClient()
    ZStack {
        VColor.background.ignoresSafeArea()
        SettingsPanel(onClose: {}, store: SettingsStore(daemonClient: dc), threadManager: ThreadManager(daemonClient: dc))
    }
    .frame(width: 600, height: 700)
}
