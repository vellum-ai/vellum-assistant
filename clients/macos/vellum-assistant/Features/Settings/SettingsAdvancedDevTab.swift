import SwiftUI
import VellumAssistantShared

/// Advanced / Developer settings tab — permission simulator, feature flags,
/// and environment variables. Only visible when dev mode is enabled.
@MainActor
struct SettingsAdvancedDevTab: View {
    @ObservedObject var store: SettingsStore
    var daemonClient: DaemonClient?

    @State private var macOSFlagStates: [(flag: MacOSClientFeatureFlag, enabled: Bool)] = []
    @State private var assistantFlags: [DaemonClient.AssistantFeatureFlagEntry] = []
    @State private var assistantFlagsLoading = false
    @State private var assistantFlagsError: String?
    @State private var showingEnvVars = false
    @State private var appEnvVars: [(String, String)] = []
    @State private var daemonEnvVars: [(String, String)] = []
    @State private var testerModel: ToolPermissionTesterModel?

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.xl) {
            // Permission Simulator
            if let model = testerModel {
                ToolPermissionTesterView(model: model)
            }

            // Assistant Feature Flags (gateway-backed)
            assistantFeatureFlagSection

            // macOS Feature Flags (local-only)
            macOSFeatureFlagSection

            // Developer section (env vars)
            developerSection
        }
        .onAppear {
            macOSFlagStates = MacOSClientFeatureFlag.allCases.map { flag in
                (flag: flag, enabled: MacOSClientFeatureFlagManager.shared.isEnabled(flag))
            }
            if testerModel == nil, let dc = daemonClient {
                testerModel = ToolPermissionTesterModel(daemonClient: dc)
            }
            loadAssistantFlags()
        }
        .sheet(isPresented: $showingEnvVars) {
            SettingsPanelEnvVarsSheet(appEnvVars: appEnvVars, daemonEnvVars: daemonEnvVars)
        }
        .onDisappear {
            daemonClient?.onEnvVarsResponse = nil
        }
    }

    // MARK: - Assistant Feature Flags

    private func loadAssistantFlags() {
        guard let dc = daemonClient else { return }
        assistantFlagsLoading = true
        assistantFlagsError = nil
        Task {
            do {
                let flags = try await dc.fetchAssistantFeatureFlags()
                assistantFlags = flags
            } catch {
                assistantFlagsError = error.localizedDescription
            }
            assistantFlagsLoading = false
        }
    }

    private var assistantFeatureFlagSection: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            Text("Assistant Feature Flags")
                .font(VFont.sectionTitle)
                .foregroundColor(VColor.textPrimary)

            if assistantFlagsLoading {
                HStack(spacing: VSpacing.sm) {
                    ProgressView()
                        .controlSize(.small)
                    Text("Loading...")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)
                }
            } else if let error = assistantFlagsError {
                Text(error)
                    .font(VFont.caption)
                    .foregroundColor(VColor.error)
            } else if assistantFlags.isEmpty {
                Text("No assistant feature flags available.")
                    .font(VFont.caption)
                    .foregroundColor(VColor.textMuted)
            } else {
                ForEach(Array(assistantFlags.enumerated()), id: \.element.key) { index, entry in
                    VStack(alignment: .leading, spacing: VSpacing.xxs) {
                        Toggle(entry.key, isOn: Binding(
                            get: { assistantFlags[index].enabled },
                            set: { newValue in
                                let flagKey = assistantFlags[index].key
                                assistantFlags[index] = DaemonClient.AssistantFeatureFlagEntry(
                                    key: flagKey,
                                    enabled: newValue,
                                    defaultEnabled: assistantFlags[index].defaultEnabled,
                                    description: assistantFlags[index].description
                                )
                                Task {
                                    try? await daemonClient?.setFeatureFlag(key: flagKey, enabled: newValue)
                                }
                            }
                        ))
                        .toggleStyle(.switch)
                        .font(VFont.body)
                        .foregroundColor(VColor.textSecondary)

                        if !entry.description.isEmpty {
                            Text(entry.description)
                                .font(VFont.caption)
                                .foregroundColor(VColor.textMuted)
                        }
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(VSpacing.lg)
        .vCard(background: VColor.surfaceSubtle)
    }

    // MARK: - macOS Feature Flags

    private var macOSFeatureFlagSection: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            Text("macOS Feature Flags")
                .font(VFont.sectionTitle)
                .foregroundColor(VColor.textPrimary)

            ForEach(Array(macOSFlagStates.enumerated()), id: \.element.flag) { index, entry in
                Toggle(entry.flag.displayName, isOn: Binding(
                    get: { macOSFlagStates[index].enabled },
                    set: { newValue in
                        macOSFlagStates[index].enabled = newValue
                        MacOSClientFeatureFlagManager.shared.setOverride(entry.flag, enabled: newValue)
                    }
                ))
                .toggleStyle(.switch)
                .font(VFont.body)
                .foregroundColor(VColor.textSecondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(VSpacing.lg)
        .vCard(background: VColor.surfaceSubtle)
    }

    // MARK: - Developer

    @ViewBuilder
    private var developerSection: some View {
        if daemonClient != nil {
            VStack(alignment: .leading, spacing: VSpacing.md) {
                Text("Developer")
                    .font(VFont.sectionTitle)
                    .foregroundColor(VColor.textPrimary)

                HStack {
                    VStack(alignment: .leading, spacing: VSpacing.xs) {
                        Text("Environment Variables")
                            .font(VFont.body)
                            .foregroundColor(VColor.textSecondary)
                        Text("View env vars for both the app and daemon processes")
                            .font(VFont.caption)
                            .foregroundColor(VColor.textMuted)
                    }
                    Spacer()
                    VButton(label: "View...", style: .tertiary) {
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
            .vCard(background: VColor.surfaceSubtle)
        }
    }
}
