import SwiftUI
import VellumAssistantShared

/// Advanced / Developer settings tab — permission simulator, feature flags,
/// and environment variables. Only visible when dev mode is enabled.
@MainActor
struct SettingsAdvancedDevTab: View {
    @ObservedObject var store: SettingsStore
    var daemonClient: DaemonClient?

    @State private var macOSFlagStates: [MacOSFeatureFlagState] = []
    @State private var assistantFlags: [DaemonClient.AssistantFeatureFlag] = []
    @State private var assistantFlagsError: String?
    @State private var isLoadingAssistantFlags = false
    @State private var showingEnvVars = false
    @State private var appEnvVars: [(String, String)] = []
    @State private var daemonEnvVars: [(String, String)] = []
    @State private var testerModel: ToolPermissionTesterModel?

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            // Permission Simulator
            if let model = testerModel {
                ToolPermissionTesterView(model: model)
            }

            // Assistant Feature Flags (gateway-sourced)
            assistantFeatureFlagSection

            // macOS Feature Flags (local)
            macOSFeatureFlagSection

            // Developer section (env vars)
            developerSection
        }
        .onAppear {
            macOSFlagStates = MacOSClientFeatureFlagManager.shared.allFlagStates()
            if testerModel == nil, let dc = daemonClient {
                testerModel = ToolPermissionTesterModel(daemonClient: dc)
            }
            Task { await loadAssistantFlags() }
        }
        .sheet(isPresented: $showingEnvVars) {
            SettingsPanelEnvVarsSheet(appEnvVars: appEnvVars, daemonEnvVars: daemonEnvVars)
        }
        .onDisappear {
            daemonClient?.onEnvVarsResponse = nil
        }
    }

    // MARK: - Assistant Feature Flags

    private func loadAssistantFlags() async {
        guard let daemonClient else { return }
        isLoadingAssistantFlags = true
        assistantFlagsError = nil
        do {
            assistantFlags = try await daemonClient.getFeatureFlags()
        } catch {
            assistantFlagsError = error.localizedDescription
        }
        isLoadingAssistantFlags = false
    }

    private var assistantFeatureFlagSection: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            HStack {
                Text("Assistant Feature Flags")
                    .font(VFont.sectionTitle)
                    .foregroundColor(VColor.textPrimary)
                Spacer()
                if isLoadingAssistantFlags {
                    ProgressView()
                        .controlSize(.small)
                        .progressViewStyle(.circular)
                }
            }

            Text("Sourced from the gateway API. Changes are synced remotely.")
                .font(VFont.sectionDescription)
                .foregroundColor(VColor.textMuted)

            if let error = assistantFlagsError {
                HStack(spacing: VSpacing.xs) {
                    VIconView(.triangleAlert, size: 12)
                        .foregroundColor(VColor.warning)
                    Text(error)
                        .font(VFont.caption)
                        .foregroundColor(VColor.error)
                }
            } else if assistantFlags.isEmpty && !isLoadingAssistantFlags {
                Text("No assistant feature flags available.")
                    .font(VFont.body)
                    .foregroundColor(VColor.textMuted)
            } else {
                ForEach(assistantFlags) { flag in
                    assistantFlagRow(flag: flag)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(VSpacing.lg)
        .vCard(background: VColor.surfaceSubtle)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func assistantFlagRow(flag: DaemonClient.AssistantFeatureFlag) -> some View {
        let flagBinding = Binding<Bool>(
            get: {
                assistantFlags.first(where: { $0.key == flag.key })?.enabled ?? flag.enabled
            },
            set: { newValue in
                // Optimistically update local state
                if let index = assistantFlags.firstIndex(where: { $0.key == flag.key }) {
                    assistantFlags[index] = DaemonClient.AssistantFeatureFlag(
                        key: flag.key,
                        enabled: newValue,
                        defaultEnabled: flag.defaultEnabled,
                        description: flag.description,
                        label: flag.label
                    )
                }
                // Persist via gateway API
                NotificationCenter.default.post(
                    name: .assistantFeatureFlagDidChange,
                    object: nil,
                    userInfo: ["key": flag.key, "enabled": newValue]
                )
                Task {
                    do {
                        try await daemonClient?.setFeatureFlag(key: flag.key, enabled: newValue)
                    } catch {
                        // Revert on failure
                        if let index = assistantFlags.firstIndex(where: { $0.key == flag.key }) {
                            assistantFlags[index] = DaemonClient.AssistantFeatureFlag(
                                key: flag.key,
                                enabled: !newValue,
                                defaultEnabled: flag.defaultEnabled,
                                description: flag.description,
                                label: flag.label
                            )
                        }
                        NotificationCenter.default.post(
                            name: .assistantFeatureFlagDidChange,
                            object: nil,
                            userInfo: ["key": flag.key, "enabled": !newValue]
                        )
                    }
                }
            }
        )
        return HStack {
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text(flag.displayName)
                    .font(VFont.body)
                    .foregroundColor(VColor.textSecondary)
                if let description = flag.description, !description.isEmpty {
                    Text(description)
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)
                }
            }
            Spacer()
            VToggle(isOn: flagBinding)
                .accessibilityLabel(flag.displayName)
        }
        .contentShape(Rectangle())
        .onTapGesture { withAnimation { flagBinding.wrappedValue.toggle() } }
    }

    private func macOSFlagRow(index: Int, entry: MacOSFeatureFlagState) -> some View {
        let flagBinding = Binding<Bool>(
            get: { macOSFlagStates[index].enabled },
            set: { newValue in
                macOSFlagStates[index].enabled = newValue
                MacOSClientFeatureFlagManager.shared.setOverride(entry.key, enabled: newValue)
                NotificationCenter.default.post(
                    name: .assistantFeatureFlagDidChange,
                    object: nil,
                    userInfo: ["key": entry.key, "enabled": newValue]
                )
            }
        )
        return HStack {
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text(entry.label)
                    .font(VFont.body)
                    .foregroundColor(VColor.textSecondary)
                if !entry.description.isEmpty {
                    Text(entry.description)
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)
                }
            }
            Spacer()
            VToggle(isOn: flagBinding)
                .accessibilityLabel(entry.label)
        }
        .contentShape(Rectangle())
        .onTapGesture { withAnimation { flagBinding.wrappedValue.toggle() } }
    }

    // MARK: - macOS Feature Flags

    private var macOSFeatureFlagSection: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text("macOS Feature Flags")
                    .font(VFont.sectionTitle)
                    .foregroundColor(VColor.textPrimary)

                Text("Local-only flags stored in UserDefaults on this Mac.")
                    .font(VFont.sectionDescription)
                    .foregroundColor(VColor.textMuted)
            }

            if macOSFlagStates.isEmpty {
                Text("No macOS feature flags available.")
                    .font(VFont.body)
                    .foregroundColor(VColor.textMuted)
            } else {
                ForEach(Array(macOSFlagStates.enumerated()), id: \.element.id) { index, entry in
                    macOSFlagRow(index: index, entry: entry)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(VSpacing.lg)
        .vCard(background: VColor.surfaceSubtle)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - Developer

    @ViewBuilder
    private var developerSection: some View {
        if daemonClient != nil {
            VStack(alignment: .leading, spacing: VSpacing.md) {
                Text("Developer")
                    .font(VFont.sectionTitle)
                    .foregroundColor(VColor.textPrimary)

                VStack(alignment: .leading, spacing: VSpacing.md) {
                    VStack(alignment: .leading, spacing: VSpacing.sm) {
                        Text("Environment Variables")
                            .font(VFont.inputLabel)
                            .foregroundColor(VColor.textSecondary)
                        Text("View env vars for both the app and daemon processes")
                            .font(VFont.caption)
                            .foregroundColor(VColor.textMuted)
                    }
                    VButton(label: "View...", style: .secondary) {
                        appEnvVars = ProcessInfo.processInfo.environment
                            .sorted(by: { $0.key < $1.key })
                            .map { ($0.key, $0.value) }
                        daemonEnvVars = []
                        daemonClient?.onEnvVarsResponse = { response in
                            Task { @MainActor in
                                self.daemonEnvVars = response.vars
                                    .sorted(by: { $0.key < $1.key })
                                    .map { ($0.key, $0.value) }
                            }
                        }
                        try? daemonClient?.sendEnvVarsRequest()
                        showingEnvVars = true
                    }
                }
            }
            .padding(VSpacing.lg)
            .frame(maxWidth: .infinity, alignment: .leading)
            .vCard(background: VColor.surfaceSubtle)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}
