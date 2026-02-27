import SwiftUI
import VellumAssistantShared

/// Advanced / Developer settings tab — permission simulator, feature flags,
/// and environment variables. Only visible when dev mode is enabled.
@MainActor
struct SettingsAdvancedDevTab: View {
    @ObservedObject var store: SettingsStore
    var daemonClient: DaemonClient?

    @State private var flagStates: [(flag: FeatureFlag, enabled: Bool)] = []
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

            // Feature Flags
            featureFlagSection

            // Developer section (env vars)
            developerSection
        }
        .onAppear {
            flagStates = FeatureFlag.allCases.map { flag in
                (flag: flag, enabled: FeatureFlagManager.shared.isEnabled(flag))
            }
            if testerModel == nil, let dc = daemonClient {
                testerModel = ToolPermissionTesterModel(daemonClient: dc)
            }
        }
        .sheet(isPresented: $showingEnvVars) {
            SettingsPanelEnvVarsSheet(appEnvVars: appEnvVars, daemonEnvVars: daemonEnvVars)
        }
        .onDisappear {
            daemonClient?.onEnvVarsResponse = nil
        }
    }

    // MARK: - Feature Flags

    private var featureFlagSection: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            Text("Feature Flags")
                .font(VFont.sectionTitle)
                .foregroundColor(VColor.textPrimary)

            ForEach(Array(flagStates.enumerated()), id: \.element.flag) { index, entry in
                Toggle(entry.flag.displayName, isOn: Binding(
                    get: { flagStates[index].enabled },
                    set: { newValue in
                        flagStates[index].enabled = newValue
                        FeatureFlagManager.shared.setOverride(entry.flag, enabled: newValue)
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
