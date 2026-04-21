import SwiftUI
import VellumAssistantShared
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "ComposerThresholdPicker")

// MARK: - Threshold Preset

/// The three presets surfaced in the per-conversation threshold picker.
/// Each maps to a concrete ``RiskThreshold`` value.
enum ThresholdPreset: String, CaseIterable, Identifiable, Equatable {
    /// Prompt for everything (maps to ``RiskThreshold.none``).
    case strict
    /// Match the global interactive default (no override stored).
    case `default`
    /// Auto-approve most tools (maps to ``RiskThreshold.medium``).
    case relaxed

    var id: String { rawValue }

    var label: String {
        switch self {
        case .strict: return "Strict"
        case .default: return "Default"
        case .relaxed: return "Relaxed"
        }
    }

    var description: String {
        switch self {
        case .strict: return "Prompt for everything"
        case .default: return "Auto-approve low-risk tools"
        case .relaxed: return "Auto-approve most tools"
        }
    }

    var icon: VIcon {
        switch self {
        case .strict: return .lock
        case .default: return .shieldCheck
        case .relaxed: return .triangleAlert
        }
    }

    var iconColor: Color {
        switch self {
        case .strict: return VColor.contentSecondary
        case .default: return VColor.contentSecondary
        case .relaxed: return VColor.systemMidStrong
        }
    }

    /// The ``RiskThreshold`` raw value to write when this preset is selected.
    /// Returns `nil` for `.default` — the caller should delete the override instead.
    var thresholdValue: String? {
        switch self {
        case .strict: return RiskThreshold.none.rawValue
        case .default: return nil
        case .relaxed: return RiskThreshold.medium.rawValue
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

        // Compare by risk level ordering: none < low < medium
        let order: [String] = [
            RiskThreshold.none.rawValue,
            RiskThreshold.low.rawValue,
            RiskThreshold.medium.rawValue,
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
/// with three presets: Strict, Default, and Relaxed.
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

    #if os(macOS)
    @State private var isMenuOpen = false
    @State private var activePanel: VMenuPanel?
    @State private var triggerFrame: CGRect = .zero
    #endif

    private let composerActionButtonSize: CGFloat = 32

    var body: some View {
        #if os(macOS)
        Button {
            if isMenuOpen {
                activePanel?.close()
                activePanel = nil
                isMenuOpen = false
            } else {
                showMenu()
            }
        } label: {
            HStack(spacing: 4) {
                VIconView(currentPreset.icon, size: 14)
                    .foregroundStyle(currentPreset.iconColor)
                Text(currentPreset.label)
                    .font(VFont.labelDefault)
                    .foregroundStyle(
                        currentPreset == .relaxed
                            ? VColor.systemMidStrong
                            : VColor.contentSecondary
                    )
                VIconView(.chevronDown, size: 10)
                    .foregroundStyle(VColor.contentTertiary)
            }
            .frame(height: composerActionButtonSize)
            .padding(.horizontal, VSpacing.xs)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .vTooltip(currentPreset.description)
        .accessibilityLabel("Risk tolerance")
        .accessibilityValue(currentPreset.label)
        .overlay {
            GeometryReader { geo in
                Color.clear
                    .onAppear { triggerFrame = geo.frame(in: .global) }
                    .onChange(of: geo.frame(in: .global)) { _, newFrame in
                        triggerFrame = newFrame
                    }
            }
        }
        .task(id: conversationId) {
            hasUserInteracted = false
            await loadState()
        }
        #endif
    }

    // MARK: - Menu

    #if os(macOS)
    private func showMenu() {
        guard !isMenuOpen else { return }
        isMenuOpen = true

        NSApp.keyWindow?.makeFirstResponder(nil)

        guard let window = NSApp.keyWindow ?? NSApp.windows.first(where: { $0.isVisible }) else {
            isMenuOpen = false
            return
        }

        let triggerInWindow = CGPoint(x: triggerFrame.minX, y: triggerFrame.maxY)
        let screenPoint = window.convertPoint(toScreen: NSPoint(
            x: triggerInWindow.x,
            y: window.frame.height - triggerInWindow.y
        ))

        let triggerScreenOrigin = window.convertPoint(toScreen: NSPoint(
            x: triggerFrame.minX,
            y: window.frame.height - triggerFrame.maxY
        ))
        let triggerScreenRect = CGRect(
            origin: triggerScreenOrigin,
            size: CGSize(width: triggerFrame.width, height: triggerFrame.height)
        )

        let appearance = window.effectiveAppearance
        activePanel = VMenuPanel.show(
            at: screenPoint,
            sourceWindow: window,
            sourceAppearance: appearance,
            excludeRect: triggerScreenRect
        ) {
            VMenu(width: 240) {
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
        } onDismiss: {
            isMenuOpen = false
            activePanel = nil
        }
    }
    #endif

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
