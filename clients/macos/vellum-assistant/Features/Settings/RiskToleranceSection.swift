import SwiftUI
import VellumAssistantShared
import os

private let riskToleranceLog = Logger(
    subsystem: Bundle.appBundleIdentifier,
    category: "RiskToleranceSection"
)

/// Risk Tolerance settings section — lets the user configure auto-approve
/// thresholds for interactive, background, and headless execution contexts.
///
/// Layout:
/// - Interactive  (top-level, always visible)
/// - Advanced accordion
///   - Background  (scheduled tasks, background jobs)
///   - Headless    (externally-triggered, no interactive client)
@MainActor
struct RiskToleranceSection: View {
    var thresholdClient: ThresholdClientProtocol
    var assistantFeatureFlagStore: AssistantFeatureFlagStore

    /// Current selection for the interactive ("Interactive") threshold.
    /// Pre-load placeholder; reconciled with the gateway on appearance.
    @State private var interactiveSelection: RiskThreshold = .medium

    /// Current selection for the background ("Background") threshold.
    /// Stored as `autonomous` in the API; labelled "Background" in the UI.
    @State private var backgroundSelection: RiskThreshold = .low

    /// Current selection for the headless ("Headless") threshold.
    /// Defaults to Strict — headless contexts are most susceptible to
    /// prompt injection via webhook ingress.
    @State private var headlessSelection: RiskThreshold = .none

    /// Whether the Advanced accordion is expanded.
    @State private var isAdvancedExpanded: Bool = false

    /// In-flight sync task. Writes are serialized so rapid picker changes
    /// resolve in order and the latest selection wins deterministically.
    @State private var syncTask: Task<Void, Never>?
    /// Monotonic sync version used to drop superseded queued writes.
    @State private var syncVersion: UInt64 = 0

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

            // ── Interactive ───────────────────────────────────────────────

            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text("Interactive")
                    .font(VFont.bodyMediumDefault)
                    .foregroundStyle(VColor.contentDefault)
                Text("When you're chatting with your assistant directly.")
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentTertiary)
                ThresholdPresetDropdown(
                    preset: ThresholdPreset.from(riskThreshold: interactiveSelection),
                    accessibilityLabel: "Interactive risk threshold"
                ) { preset in
                    hasUserInteracted = true
                    interactiveSelection = preset.riskThreshold
                    syncThresholds()
                }
                Text(interactiveSelection.settingsDescription)
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentTertiary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            SettingsDivider()

            // ── Advanced accordion (Background + Headless) ────────────────

            VDisclosureSection(
                title: "Advanced",
                subtitle: "Background & Headless execution contexts",
                isExpanded: $isAdvancedExpanded
            ) {
                VStack(alignment: .leading, spacing: VSpacing.md) {

                    // ── Background ────────────────────────────────────────

                    VStack(alignment: .leading, spacing: VSpacing.xs) {
                        Text("Background")
                            .font(VFont.bodyMediumDefault)
                            .foregroundStyle(VColor.contentDefault)
                        Text("When your assistant acts without you — scheduled tasks, background jobs, and external triggers.")
                            .font(VFont.labelDefault)
                            .foregroundStyle(VColor.contentTertiary)
                        ThresholdPresetDropdown(
                            preset: ThresholdPreset.from(riskThreshold: backgroundSelection),
                            accessibilityLabel: "Background risk threshold"
                        ) { preset in
                            hasUserInteracted = true
                            backgroundSelection = preset.riskThreshold
                            syncThresholds()
                        }
                        Text(backgroundSelection.settingsDescription)
                            .font(VFont.labelDefault)
                            .foregroundStyle(VColor.contentTertiary)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)

                    SettingsDivider()

                    // ── Headless ──────────────────────────────────────────

                    VStack(alignment: .leading, spacing: VSpacing.xs) {
                        Text("Headless")
                            .font(VFont.bodyMediumDefault)
                            .foregroundStyle(VColor.contentDefault)
                        Text("When your assistant is triggered externally with no interactive client — webhooks, API calls, and other automated ingress. Defaults to Strict due to prompt injection risk.")
                            .font(VFont.labelDefault)
                            .foregroundStyle(VColor.contentTertiary)
                        ThresholdPresetDropdown(
                            preset: ThresholdPreset.from(riskThreshold: headlessSelection),
                            accessibilityLabel: "Headless risk threshold"
                        ) { preset in
                            hasUserInteracted = true
                            headlessSelection = preset.riskThreshold
                            syncThresholds()
                        }
                        Text(headlessSelection.settingsDescription)
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
                hasLoadedInitial = true
                guard !hasUserInteracted else { return }
                interactiveSelection = RiskThreshold(rawValue: thresholds.interactive) ?? .medium
                backgroundSelection = RiskThreshold(rawValue: thresholds.autonomous) ?? .low
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

    /// Syncs the current threshold selections to the gateway. Writes are
    /// serialized rather than cancelled because cancellation does not
    /// guarantee an in-flight HTTP request stops server-side.
    ///
    /// If the PUT fails, clears `hasUserInteracted` so a subsequent
    /// `loadThresholds()` call can reconcile the picker against the
    /// authoritative gateway state.
    private func syncThresholds() {
        // Don't sync until we've loaded at least once — otherwise we'd
        // persist stale local defaults over the real server state.
        guard hasLoadedInitial else { return }

        let payload = GlobalThresholds(
            interactive: interactiveSelection.rawValue,
            autonomous: backgroundSelection.rawValue,
            headless: headlessSelection.rawValue
        )
        syncVersion &+= 1
        let requestVersion = syncVersion
        let previousSync = syncTask

        syncTask = Task {
            await previousSync?.value
            guard requestVersion == syncVersion else { return }
            do {
                try await thresholdClient.setGlobalThresholds(payload)
                guard requestVersion == syncVersion else { return }
                NotificationCenter.default.post(name: .globalRiskThresholdsDidChange, object: nil)
            } catch {
                riskToleranceLog.error(
                    "setGlobalThresholds failed: \(error.localizedDescription, privacy: .public)"
                )
                if requestVersion == syncVersion {
                    hasUserInteracted = false
                }
            }
        }
    }
}
