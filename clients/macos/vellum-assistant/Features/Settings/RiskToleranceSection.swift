import SwiftUI
import VellumAssistantShared
import os

private let riskToleranceLog = Logger(
    subsystem: Bundle.appBundleIdentifier,
    category: "RiskToleranceSection"
)

/// Risk Tolerance settings section — lets the user configure auto-approve
/// thresholds for interactive and autonomous execution contexts.
@MainActor
struct RiskToleranceSection: View {
    var thresholdClient: ThresholdClientProtocol
    var assistantFeatureFlagStore: AssistantFeatureFlagStore

    /// Current selection for the interactive ("Conversations") threshold.
    /// Defaults to `.low` to match the gateway schema default.
    @State private var interactiveSelection: RiskThreshold = .low

    /// Current selection for the autonomous threshold.
    /// Defaults to `.none` to match the gateway schema default.
    @State private var autonomousSelection: RiskThreshold = .none

    /// In-flight sync task so rapid picker changes cancel the previous
    /// write and only the latest selection reaches the gateway.
    @State private var syncTask: Task<Void, Never>?

    /// In-flight load task so repeated view appearances don't stack
    /// concurrent GETs against the gateway.
    @State private var loadTask: Task<Void, Never>?

    /// Whether the initial load from the gateway has completed at least
    /// once. Prevents `syncThresholds()` from persisting stale defaults
    /// before we know the real server state.
    @State private var hasLoadedInitial: Bool = false

    /// Tracks whether the user has actively picked an option since the
    /// view appeared. Once set, `loadThresholds()` will NOT overwrite
    /// selections with the gateway's reconciled value — otherwise a late
    /// GET response could stomp a user's mid-load selection with stale
    /// server data.
    @State private var hasUserInteracted: Bool = false

    var body: some View {
        SettingsCard(title: "Risk Tolerance") {
            Text("Control which actions your assistant can take without asking first. Each action is classified by risk level — your tolerance determines which levels auto-approve.")
                .font(VFont.bodyMediumDefault)
                .foregroundStyle(VColor.contentTertiary)
                .frame(maxWidth: .infinity, alignment: .leading)

            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text("Conversations")
                    .font(VFont.bodyMediumDefault)
                    .foregroundStyle(VColor.contentDefault)
                Text("When you're chatting with your assistant directly.")
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentTertiary)
                VDropdown(
                    options: RiskThreshold.allCases.map {
                        VDropdownOption(label: $0.label, value: $0, icon: $0.icon)
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
                .accessibilityLabel("Conversations risk threshold")
                Text(interactiveSelection.settingsDescription)
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentTertiary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            SettingsDivider()

            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text("Autonomous")
                    .font(VFont.bodyMediumDefault)
                    .foregroundStyle(VColor.contentDefault)
                Text("When your assistant acts without you — scheduled tasks, background jobs, and external triggers.")
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentTertiary)
                VDropdown(
                    options: RiskThreshold.allCases.map {
                        VDropdownOption(label: $0.label, value: $0, icon: $0.icon)
                    },
                    selection: Binding(
                        get: { autonomousSelection },
                        set: { newValue in
                            hasUserInteracted = true
                            autonomousSelection = newValue
                            syncThresholds()
                        }
                    ),
                    maxWidth: 280
                )
                .accessibilityLabel("Autonomous risk threshold")
                Text(autonomousSelection.settingsDescription)
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentTertiary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
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
                hasLoadedInitial = true
                guard !hasUserInteracted else { return }
                interactiveSelection = RiskThreshold(rawValue: thresholds.interactive) ?? .low
                autonomousSelection = RiskThreshold(rawValue: thresholds.autonomous) ?? .none
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
        // Don't sync until we've loaded at least once — otherwise we'd
        // persist stale local defaults over the real server state.
        guard hasLoadedInitial else { return }
        syncTask?.cancel()
        syncTask = Task {
            do {
                try await thresholdClient.setGlobalThresholds(
                    GlobalThresholds(
                        interactive: interactiveSelection.rawValue,
                        autonomous: autonomousSelection.rawValue
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
