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
    /// Match the global interactive default (no override stored).
    case `default`
    /// Auto-approve most tools (maps to ``RiskThreshold.medium``).
    case relaxed
    /// Auto-approve all actions (maps to ``RiskThreshold.high``).
    case fullAccess

    var id: String { rawValue }

    var label: String {
        switch self {
        case .strict: return "Strict"
        case .default: return "Default"
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
        case .relaxed: return .triangleAlert
        case .fullAccess: return .shieldOff
        }
    }

    var iconColor: Color {
        switch self {
        case .strict: return VColor.contentSecondary
        case .default: return VColor.contentSecondary
        case .relaxed: return VColor.systemMidStrong
        case .fullAccess: return VColor.systemNegativeStrong
        }
    }

    /// The ``RiskThreshold`` raw value to write when this preset is selected.
    /// Returns `nil` for `.default` — the caller should delete the override instead.
    var thresholdValue: String? {
        switch self {
        case .strict: return RiskThreshold.none.rawValue
        case .default: return nil
        case .relaxed: return RiskThreshold.medium.rawValue
        case .fullAccess: return RiskThreshold.high.rawValue
        }
    }

    /// Determines the preset that best describes a conversation override value
    /// relative to the global interactive default.
    ///
    /// - Parameters:
    ///   - override: The conversation-level threshold string, or `nil` when no
    ///     override exists.
    ///   - globalInteractive: The global interactive threshold raw value.
    /// - Returns: The matching preset.
    static func from(override: String?, globalInteractive: String) -> ThresholdPreset {
        guard let override else { return .default }
        if override == globalInteractive { return .default }

        // Check for exact matches to named presets first
        if override == RiskThreshold.high.rawValue { return .fullAccess }

        // Compare by risk level ordering: none < low < medium < high
        let order: [String] = [
            RiskThreshold.none.rawValue,
            RiskThreshold.low.rawValue,
            RiskThreshold.medium.rawValue,
            RiskThreshold.high.rawValue,
        ]
        let overrideIndex = order.firstIndex(of: override) ?? 0
        let globalIndex = order.firstIndex(of: globalInteractive) ?? 0

        if overrideIndex < globalIndex {
            return .strict
        } else if overrideIndex > globalIndex {
            return .relaxed
        } else {
            return .default
        }
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
    @State private var currentPreset: ThresholdPreset = .default

    /// The global interactive threshold raw value, fetched on load.
    @State private var globalInteractive: String = RiskThreshold.low.rawValue

    /// In-flight write task, cancelled on rapid re-selection.
    @State private var writeTask: Task<Void, Never>?

    /// In-flight load task, cancelled on re-appearance.
    @State private var loadTask: Task<Void, Never>?

    /// Tracks whether the user has actively picked since last load so stale
    /// GET responses don't overwrite an optimistic selection.
    @State private var hasUserInteracted: Bool = false

    private var pillLabelColor: Color {
        switch currentPreset {
        case .fullAccess: return VColor.systemNegativeStrong
        case .relaxed: return VColor.systemMidStrong
        default: return VColor.contentSecondary
        }
    }

    var body: some View {
        #if os(macOS)
        ComposerPillMenu(
            accessibilityLabel: "Risk tolerance",
            accessibilityValue: currentPreset.label,
            tooltip: currentPreset.description
        ) {
            VIconView(currentPreset.icon, size: 14)
                .foregroundStyle(currentPreset.iconColor)
            Text(currentPreset.label)
                .font(VFont.labelDefault)
                .foregroundStyle(pillLabelColor)
        } menu: {
            ForEach(ThresholdPreset.allCases) { preset in
                VMenuItem(
                    icon: preset.icon.rawValue,
                    label: preset.label,
                    isActive: currentPreset == preset,
                    size: .regular
                ) {
                    selectPreset(preset)
                } trailing: {
                    VStack(alignment: .trailing, spacing: 2) {
                        if currentPreset == preset {
                            VIconView(.check, size: 12)
                                .foregroundStyle(VColor.primaryBase)
                        }
                    }
                }
            }
        }
        .task(id: assistantConversationId ?? "draft:\(draftInteractiveOverride ?? "nil")") {
            hasUserInteracted = false
            await loadState()
        }
        #endif
    }

    // MARK: - Selection

    private func selectPreset(_ preset: ThresholdPreset) {
        hasUserInteracted = true
        withAnimation(VAnimation.fast) {
            currentPreset = preset
        }

        writeTask?.cancel()
        writeTask = Task { @MainActor in
            do {
                onDraftInteractiveOverrideChange?(
                    Self.stagedDraftOverride(
                        for: preset,
                        globalInteractive: globalInteractive
                    )
                )
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
                    // avoid a one-frame "Default" flash.
                    override = conversationOverride ?? draftInteractiveOverride
                } else {
                    override = draftInteractiveOverride
                }

                guard !Task.isCancelled, !hasUserInteracted else { return }
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
        if let value = preset.thresholdValue,
           value != globalInteractive {
            return .set(value)
        }
        // Default or matching global — remove the override row.
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
