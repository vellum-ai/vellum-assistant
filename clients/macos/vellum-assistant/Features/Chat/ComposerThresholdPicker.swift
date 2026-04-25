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
    let conversationId: UUID?
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
        .task(id: conversationId) {
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
        writeTask = Task {
            guard let conversationId else { return }
            let conversationIdString = conversationId.uuidString.lowercased()

            do {
                if let value = preset.thresholdValue,
                   value != globalInteractive {
                    try await thresholdClient.setConversationOverride(
                        conversationId: conversationIdString,
                        threshold: value
                    )
                } else {
                    // Default or matching global — remove the override row.
                    try await thresholdClient.deleteConversationOverride(
                        conversationId: conversationIdString
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
                if let conversationId {
                    let conversationIdString = conversationId.uuidString.lowercased()
                    override = try await thresholdClient.getConversationOverride(
                        conversationId: conversationIdString
                    )
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
}
