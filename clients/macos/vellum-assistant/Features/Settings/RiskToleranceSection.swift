import SwiftUI
import VellumAssistantShared
import os

private let riskToleranceLog = Logger(
    subsystem: Bundle.appBundleIdentifier,
    category: "RiskToleranceSection"
)

/// Risk Tolerance settings section — lets the user configure auto-approve
/// thresholds for interactive, background, and headless execution contexts.
@MainActor
struct RiskToleranceSection: View {
    var thresholdClient: ThresholdClientProtocol
    var assistantFeatureFlagStore: AssistantFeatureFlagStore

    /// Current selection for the interactive ("When chatting") threshold.
    @State private var interactiveSelection: RiskThreshold = .none

    /// Current selection for the background ("Scheduled tasks") threshold.
    @State private var backgroundSelection: RiskThreshold = .none

    /// Current selection for the headless ("Automation / API") threshold.
    @State private var headlessSelection: RiskThreshold = .none

    /// In-flight sync task so rapid picker changes cancel the previous
    /// write and only the latest selection reaches the gateway.
    @State private var syncTask: Task<Void, Never>?

    /// In-flight load task so repeated view appearances don't stack
    /// concurrent GETs against the gateway.
    @State private var loadTask: Task<Void, Never>?

    /// Tracks whether the user has actively picked an option since the
    /// view appeared. Once set, `loadThresholds()` will NOT overwrite
    /// selections with the gateway's reconciled value — otherwise a late
    /// GET response could stomp a user's mid-load selection with stale
    /// server data.
    @State private var hasUserInteracted: Bool = false

    var body: some View {
        SettingsCard(title: "Risk Tolerance") {
            Text("Auto-approve tools up to this risk level without prompting. Higher levels mean fewer permission prompts.")
                .font(VFont.bodyMediumDefault)
                .foregroundStyle(VColor.contentTertiary)
                .frame(maxWidth: .infinity, alignment: .leading)

            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text("When chatting")
                    .font(VFont.bodyMediumDefault)
                    .foregroundStyle(VColor.contentDefault)
                VDropdown(
                    options: RiskThreshold.allCases.map {
                        VDropdownOption(label: $0.label, value: $0)
                    },
                    selection: Binding(
                        get: { interactiveSelection },
                        set: { newValue in
                            hasUserInteracted = true
                            interactiveSelection = newValue
                            syncThresholds()
                        }
                    ),
                    maxWidth: 280
                )
                .accessibilityLabel("When chatting risk threshold")
                Text("Auto-approve low-risk tools like reading files and web searches.")
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentTertiary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            DisclosureGroup("Advanced") {
                VStack(alignment: .leading, spacing: VSpacing.lg) {
                    SettingsDivider()

                    VStack(alignment: .leading, spacing: VSpacing.xs) {
                        Text("Scheduled tasks")
                            .font(VFont.bodyMediumDefault)
                            .foregroundStyle(VColor.contentDefault)
                        VDropdown(
                            options: RiskThreshold.allCases.map {
                                VDropdownOption(label: $0.label, value: $0)
                            },
                            selection: Binding(
                                get: { backgroundSelection },
                                set: { newValue in
                                    hasUserInteracted = true
                                    backgroundSelection = newValue
                                    syncThresholds()
                                }
                            ),
                            maxWidth: 280
                        )
                        .accessibilityLabel("Scheduled tasks risk threshold")
                        Text("Auto-approve tools when running scheduled background tasks.")
                            .font(VFont.labelDefault)
                            .foregroundStyle(VColor.contentTertiary)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)

                    SettingsDivider()

                    VStack(alignment: .leading, spacing: VSpacing.xs) {
                        Text("Automation / API")
                            .font(VFont.bodyMediumDefault)
                            .foregroundStyle(VColor.contentDefault)
                        VDropdown(
                            options: RiskThreshold.allCases.map {
                                VDropdownOption(label: $0.label, value: $0)
                            },
                            selection: Binding(
                                get: { headlessSelection },
                                set: { newValue in
                                    hasUserInteracted = true
                                    headlessSelection = newValue
                                    syncThresholds()
                                }
                            ),
                            maxWidth: 280
                        )
                        .accessibilityLabel("Automation / API risk threshold")
                        Text("Auto-approve tools when triggered via API or automation.")
                            .font(VFont.labelDefault)
                            .foregroundStyle(VColor.contentTertiary)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
        .task { await loadThresholds() }
    }

    // MARK: - Load Thresholds

    /// Loads the current threshold values from the gateway.
    ///
    /// Race-safety: if the user picks an option *before* the GET completes,
    /// `hasUserInteracted` will be true and the reconciliation assignment
    /// below is skipped so stale server data cannot overwrite the user's
    /// just-made selection.
    private func loadThresholds() async {
        loadTask?.cancel()
        let task = Task { @MainActor in
            do {
                let thresholds = try await thresholdClient.getGlobalThresholds()
                guard !Task.isCancelled else { return }
                guard !hasUserInteracted else { return }
                interactiveSelection = RiskThreshold(rawValue: thresholds.interactive) ?? .none
                backgroundSelection = RiskThreshold(rawValue: thresholds.background) ?? .none
                headlessSelection = RiskThreshold(rawValue: thresholds.headless) ?? .none
            } catch {
                riskToleranceLog.error(
                    "getGlobalThresholds failed: \(error.localizedDescription, privacy: .public)"
                )
            }
        }
        loadTask = task
        await task.value
    }

    // MARK: - Sync Thresholds

    /// Syncs the current threshold selections to the gateway, cancelling
    /// any in-flight sync so that only the latest state wins when the user
    /// changes rapidly.
    ///
    /// If the PUT fails, clears `hasUserInteracted` so a subsequent
    /// `loadThresholds()` call can reconcile the picker against the
    /// authoritative gateway state.
    private func syncThresholds() {
        syncTask?.cancel()
        syncTask = Task {
            do {
                try await thresholdClient.setGlobalThresholds(
                    GlobalThresholds(
                        interactive: interactiveSelection.rawValue,
                        background: backgroundSelection.rawValue,
                        headless: headlessSelection.rawValue
                    )
                )
            } catch {
                guard !Task.isCancelled else { return }
                riskToleranceLog.error(
                    "setGlobalThresholds failed: \(error.localizedDescription, privacy: .public)"
                )
                hasUserInteracted = false
            }
        }
    }
}
