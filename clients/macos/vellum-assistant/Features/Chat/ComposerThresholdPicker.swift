import SwiftUI
import VellumAssistantShared
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "ComposerThresholdPicker")

// MARK: - Threshold Preset

/// The four presets surfaced in the per-conversation threshold picker.
/// Each maps to a concrete ``RiskThreshold`` value.
enum ThresholdPreset: String, CaseIterable, Identifiable, Equatable {
    /// Prompt for everything (maps to ``RiskThreshold.none``).
    case strict
    /// Conservative: auto-approve low-risk tools (maps to ``RiskThreshold.low``).
    case `default`
    /// Auto-approve most tools (maps to ``RiskThreshold.medium``).
    case relaxed
    /// Auto-approve all actions (maps to ``RiskThreshold.high``).
    case fullAccess

    var id: String { rawValue }

    var label: String {
        switch self {
        case .strict: return "Strict"
        case .default: return "Conservative"
        case .relaxed: return "Relaxed"
        case .fullAccess: return "Full access"
        }
    }

    var description: String {
        switch self {
        case .strict: return "Prompt for everything"
        case .default: return "Auto-approve low-risk tools"
        case .relaxed: return "Auto-approve most tools"
        case .fullAccess: return "Auto-approve all actions"
        }
    }

    var icon: VIcon {
        switch self {
        case .strict: return .lock
        case .default: return .shieldCheck
        case .relaxed: return .shield
        case .fullAccess: return .shieldOff
        }
    }

    /// The ``RiskThreshold`` value represented by this preset.
    /// Each preset maps to exactly one threshold level.
    var riskThreshold: RiskThreshold {
        switch self {
        case .strict: return .none
        case .default: return .low
        case .relaxed: return .medium
        case .fullAccess: return .high
        }
    }

    /// The ``RiskThreshold`` raw value to write when this preset is selected.
    /// Returns the explicit threshold raw value to persist for each preset.
    var thresholdValue: String {
        switch self {
        case .strict: return RiskThreshold.none.rawValue
        case .default: return RiskThreshold.low.rawValue
        case .relaxed: return RiskThreshold.medium.rawValue
        case .fullAccess: return RiskThreshold.high.rawValue
        }
    }

    /// Converts a concrete risk threshold into the matching preset label.
    static func from(riskThreshold: RiskThreshold) -> ThresholdPreset {
        switch riskThreshold {
        case .none: return .strict
        case .low: return .default
        case .medium: return .relaxed
        case .high: return .fullAccess
        }
    }

    /// Determines the preset to display for a conversation threshold override,
    /// falling back to the global interactive default when no override exists.
    ///
    /// - Parameters:
    ///   - override: The conversation-level threshold string, or `nil` when no
    ///     override exists.
    ///   - globalInteractive: The global interactive threshold raw value.
    /// - Returns: The matching preset.
    static func from(override: String?, globalInteractive: String) -> ThresholdPreset {
        let globalPreset = presetForGlobalInteractive(globalInteractive)
        guard let override else { return globalPreset }
        if override == globalInteractive { return globalPreset }

        // Overrides are absolute threshold values, not relative deltas from
        // the global default. Map directly to the corresponding preset.
        guard let overrideThreshold = RiskThreshold(rawValue: override) else {
            return globalPreset
        }
        return from(riskThreshold: overrideThreshold)
    }

    /// Maps a global interactive threshold value to the preset that should be
    /// displayed when no conversation override is set.
    private static func presetForGlobalInteractive(
        _ globalInteractive: String
    ) -> ThresholdPreset {
        switch globalInteractive {
        case RiskThreshold.none.rawValue:
            return .strict
        case RiskThreshold.medium.rawValue:
            return .relaxed
        case RiskThreshold.high.rawValue:
            return .fullAccess
        default:
            return .default
        }
    }
}

// MARK: - ThresholdPresetDropdown

/// Shared dropdown for selecting one of the four risk-threshold presets.
/// Uses the same composer pill + `VMenu` treatment across chat and settings.
@MainActor
struct ThresholdPresetDropdown: View {
    let preset: ThresholdPreset
    let accessibilityLabel: String
    var onSelect: (ThresholdPreset) -> Void

    var body: some View {
        #if os(macOS)
        ComposerPillMenu(
            accessibilityLabel: accessibilityLabel,
            accessibilityValue: preset.label,
            tooltip: preset.description
        ) {
            VIconView(preset.icon, size: 14)
                .foregroundStyle(VColor.contentSecondary)
            Text(preset.label)
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentSecondary)
        } menu: {
            ForEach(ThresholdPreset.allCases) { option in
                VMenuItem(
                    icon: option.icon.rawValue,
                    label: option.label,
                    isActive: preset == option,
                    size: .regular
                ) {
                    onSelect(option)
                } trailing: {
                    VStack(alignment: .trailing, spacing: 2) {
                        if preset == option {
                            VIconView(.check, size: 12)
                                .foregroundStyle(VColor.primaryBase)
                        }
                    }
                }
            }
        }
        #endif
    }
}

// MARK: - ComposerThresholdPicker

/// A compact pill button in the composer action bar that lets the user set a
/// per-conversation auto-approve threshold override. Opens a dropdown menu
/// with four presets: Strict, Default, Relaxed, and Full access.
@MainActor
struct ComposerThresholdPicker: View {
    let assistantConversationId: String?
    let draftInteractiveOverride: String?
    let onDraftInteractiveOverrideChange: ((String?) -> Void)?
    var thresholdClient: ThresholdClientProtocol = ThresholdClient()

    /// The currently displayed preset. Updated optimistically on selection and
    /// reconciled with the gateway on appearance / conversation change.
    @State private var currentPreset: ThresholdPreset = .relaxed

    /// The global interactive threshold raw value, fetched on load.
    @State private var globalInteractive: String = RiskThreshold.medium.rawValue

    /// In-flight write task. Writes are serialized so the final selection wins
    /// even when the user changes options rapidly.
    @State private var writeTask: Task<Void, Never>?
    /// Monotonic selection version used to drop superseded queued writes.
    @State private var writeVersion: UInt64 = 0

    /// In-flight load task, cancelled on re-appearance.
    @State private var loadTask: Task<Void, Never>?

    /// Monotonic selection version used by load reconciliation. A load only
    /// applies if the user has not changed selection since that load started.
    @State private var selectionVersion: UInt64 = 0

    var body: some View {
        #if os(macOS)
        ThresholdPresetDropdown(
            preset: currentPreset,
            accessibilityLabel: "Risk tolerance"
        ) { preset in
            selectPreset(preset)
        }
        .task(id: assistantConversationId ?? "draft") {
            await loadState()
        }
        .onChange(of: draftInteractiveOverride) { _, newValue in
            guard assistantConversationId == nil else { return }
            currentPreset = ThresholdPreset.from(
                override: newValue,
                globalInteractive: globalInteractive
            )
        }
        .onReceive(NotificationCenter.default.publisher(for: .globalRiskThresholdsDidChange)) { _ in
            Task { @MainActor in
                await loadState()
            }
        }
        #endif
    }

    // MARK: - Selection

    private func selectPreset(_ preset: ThresholdPreset) {
        selectionVersion &+= 1
        withAnimation(VAnimation.fast) {
            currentPreset = preset
        }

        // Keep draft state in sync immediately so first-send bootstrap carries
        // the current selection even before any network write completes.
        onDraftInteractiveOverrideChange?(
            Self.stagedDraftOverride(
                for: preset,
                globalInteractive: globalInteractive
            )
        )

        // Serialize writes instead of canceling in-flight network calls.
        // Cancellation doesn't guarantee the underlying HTTP request stops,
        // which can produce out-of-order "higher than selected" outcomes.
        writeVersion &+= 1
        let selectionVersion = writeVersion
        let previousWrite = writeTask
        writeTask = Task { @MainActor in
            await previousWrite?.value
            guard selectionVersion == writeVersion else { return }
            do {
                if assistantConversationId == nil {
                    return
                } else {
                    try await Self.applyPresetSelection(
                        preset: preset,
                        globalInteractive: globalInteractive,
                        assistantConversationId: assistantConversationId,
                        thresholdClient: thresholdClient
                    )
                }
            } catch {
                guard !Task.isCancelled else { return }
                log.error("Failed to write conversation threshold override: \(error.localizedDescription, privacy: .public)")
            }
        }
    }

    // MARK: - Load

    /// Loads the global interactive threshold and any existing conversation
    /// override, then reconciles `currentPreset`.
    private func loadState() async {
        loadTask?.cancel()
        let selectionVersionAtLoadStart = selectionVersion
        let task = Task { @MainActor in
            do {
                let globals = try await thresholdClient.getGlobalThresholds()
                guard !Task.isCancelled else { return }
                globalInteractive = globals.interactive

                var override: String? = nil
                if let conversationIdString = Self.canonicalConversationId(assistantConversationId) {
                    let conversationOverride = try await thresholdClient.getConversationOverride(
                        conversationId: conversationIdString
                    )
                    // During first-send bootstrap, the client can receive a
                    // conversation ID before the server has persisted the new
                    // override row. Fall back to the staged draft value to
                    // avoid a one-frame flash to the global default.
                    override = conversationOverride ?? draftInteractiveOverride
                } else {
                    override = draftInteractiveOverride
                }

                guard !Task.isCancelled else { return }
                guard selectionVersionAtLoadStart == selectionVersion else { return }
                currentPreset = ThresholdPreset.from(
                    override: override,
                    globalInteractive: globals.interactive
                )
            } catch {
                guard !Task.isCancelled else { return }
                log.error("Failed to load threshold state: \(error.localizedDescription, privacy: .public)")
            }
        }
        loadTask = task
        await task.value
    }

    // MARK: - Helpers (testable)

    enum OverrideAction: Equatable {
        case set(String)
        case clear
    }

    static func canonicalConversationId(_ conversationId: String?) -> String? {
        let trimmed = conversationId?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let trimmed, !trimmed.isEmpty else { return nil }
        return trimmed.lowercased()
    }

    static func overrideAction(
        for preset: ThresholdPreset,
        globalInteractive: String
    ) -> OverrideAction {
        let value = preset.thresholdValue
        if value != globalInteractive {
            return .set(value)
        }
        // Matches global — remove the override row.
        return .clear
    }

    static func applyPresetSelection(
        preset: ThresholdPreset,
        globalInteractive: String,
        assistantConversationId: String?,
        thresholdClient: any ThresholdClientProtocol
    ) async throws {
        guard let canonicalConversationId = canonicalConversationId(assistantConversationId) else { return }
        switch overrideAction(for: preset, globalInteractive: globalInteractive) {
        case .set(let threshold):
            try await thresholdClient.setConversationOverride(
                conversationId: canonicalConversationId,
                threshold: threshold
            )
        case .clear:
            try await thresholdClient.deleteConversationOverride(
                conversationId: canonicalConversationId
            )
        }
    }

    static func stagedDraftOverride(
        for preset: ThresholdPreset,
        globalInteractive: String
    ) -> String? {
        switch overrideAction(for: preset, globalInteractive: globalInteractive) {
        case .set(let threshold): threshold
        case .clear: nil
        }
    }
}
