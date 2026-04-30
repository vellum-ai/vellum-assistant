import SwiftUI
import VellumAssistantShared
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "ComposerSettingsMenu")

/// A single icon-button in the composer action bar that opens a combined popover
/// with risk-threshold presets ("Assistant Access") and inference-profile options
/// ("Performance Mode"). Replaces the separate ``ComposerThresholdPicker`` and
/// ``ChatProfilePicker`` pills with a single sliders icon.
@MainActor
struct ComposerSettingsMenu: View {
    // MARK: - Threshold inputs

    let showThresholdSection: Bool
    let assistantConversationId: String?
    let draftInteractiveOverride: String?
    let onDraftInteractiveOverrideChange: ((String?) -> Void)?
    var thresholdClient: ThresholdClientProtocol = ThresholdClient()

    // MARK: - Profile inputs

    let inferenceProfilePicker: ChatProfilePickerConfiguration?

    // MARK: - Threshold state (mirrors ComposerThresholdPicker)

    @State private var currentPreset: ThresholdPreset = .relaxed
    @State private var globalInteractive: String = RiskThreshold.medium.rawValue
    @State private var writeTask: Task<Void, Never>?
    @State private var writeVersion: UInt64 = 0
    @State private var loadTask: Task<Void, Never>?
    @State private var selectionVersion: UInt64 = 0

    // MARK: - Panel state

    #if os(macOS)
    @State private var isMenuOpen = false
    @State private var activePanel: VMenuPanel?
    @State private var triggerFrame: CGRect = .zero
    #endif

    private let buttonSize: CGFloat = 32

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
            VIconView(.slidersHorizontal, size: 18)
                .foregroundStyle(isMenuOpen ? VColor.contentDefault : VColor.contentTertiary)
                .frame(width: buttonSize, height: buttonSize)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .vTooltip("Conversation settings")
        .accessibilityLabel("Conversation settings")
        .overlay {
            GeometryReader { geo in
                Color.clear
                    .onAppear { triggerFrame = geo.frame(in: .global) }
                    .onChange(of: geo.frame(in: .global)) { _, newFrame in
                        triggerFrame = newFrame
                    }
            }
        }
        .task(id: assistantConversationId ?? "draft") {
            await loadThresholdState()
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
                await loadThresholdState()
            }
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
        let currentPreset = currentPreset
        let config = inferenceProfilePicker
        let showThreshold = showThresholdSection

        activePanel = VMenuPanel.show(
            at: screenPoint,
            sourceWindow: window,
            sourceAppearance: appearance,
            excludeRect: triggerScreenRect
        ) {
            VMenu(width: 240) {
                if showThreshold {
                    sectionHeader("Assistant Access")

                    ForEach(ThresholdPreset.allCases) { option in
                        VMenuItem(
                            icon: option.icon.rawValue,
                            label: option.label,
                            tooltip: option.description,
                            isActive: currentPreset == option,
                            size: .regular
                        ) {
                            selectPreset(option)
                        } trailing: {
                            if currentPreset == option {
                                VIconView(.check, size: 12)
                                    .foregroundStyle(VColor.primaryBase)
                            }
                        }
                    }
                }

                if let config, !config.profiles.isEmpty {
                    let effectiveProfile = config.current ?? config.activeProfile

                    sectionHeader("Model Profile")

                    ForEach(config.profiles) { profile in
                        VMenuItem(
                            icon: VIcon.sparkles.rawValue,
                            label: profile.displayName,
                            isActive: effectiveProfile == profile.name,
                            size: .regular
                        ) {
                            config.onSelect(profile.name)
                        } trailing: {
                            if effectiveProfile == profile.name {
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

    // MARK: - Section header

    /// Divider-free section header matching the Figma popover design.
    private func sectionHeader(_ title: String) -> some View {
        HStack {
            Text(title)
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentDisabled)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, VSpacing.sm)
        .padding(.top, VSpacing.sm)
        .padding(.bottom, VSpacing.xs)
        .accessibilityAddTraits(.isHeader)
    }

    // MARK: - Threshold selection (mirrors ComposerThresholdPicker)

    private func selectPreset(_ preset: ThresholdPreset) {
        selectionVersion &+= 1
        withAnimation(VAnimation.fast) {
            currentPreset = preset
        }

        onDraftInteractiveOverrideChange?(
            ComposerThresholdPicker.stagedDraftOverride(
                for: preset,
                globalInteractive: globalInteractive
            )
        )

        writeVersion &+= 1
        let currentWriteVersion = writeVersion
        let previousWrite = writeTask
        writeTask = Task { @MainActor in
            await previousWrite?.value
            guard currentWriteVersion == writeVersion else { return }
            do {
                guard assistantConversationId != nil else { return }
                try await ComposerThresholdPicker.applyPresetSelection(
                    preset: preset,
                    globalInteractive: globalInteractive,
                    assistantConversationId: assistantConversationId,
                    thresholdClient: thresholdClient
                )
            } catch {
                guard !Task.isCancelled else { return }
                log.error("Failed to write conversation threshold override: \(error.localizedDescription, privacy: .public)")
            }
        }
    }

    // MARK: - Threshold load (mirrors ComposerThresholdPicker)

    private func loadThresholdState() async {
        guard showThresholdSection else { return }
        loadTask?.cancel()
        let selectionVersionAtLoadStart = selectionVersion
        let task = Task { @MainActor in
            do {
                let globals = try await thresholdClient.getGlobalThresholds()
                guard !Task.isCancelled else { return }
                globalInteractive = globals.interactive

                var override: String?
                if let conversationIdString = ComposerThresholdPicker.canonicalConversationId(assistantConversationId) {
                    let conversationOverride = try await thresholdClient.getConversationOverride(
                        conversationId: conversationIdString
                    )
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
}
