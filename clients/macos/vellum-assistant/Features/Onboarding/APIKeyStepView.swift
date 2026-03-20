import VellumAssistantShared
import SwiftUI

@MainActor
struct APIKeyStepView: View {
    @Bindable var state: OnboardingState
    var isAuthenticated: Bool = false
    var onHatchManaged: (() -> Void)?

    @State private var showTitle = false
    @State private var showContent = false

    private var userHostedEnabled: Bool {
        MacOSClientFeatureFlagManager.shared.isEnabled("user_hosted_enabled")
    }

    private var platformHostedEnabled: Bool {
        MacOSClientFeatureFlagManager.shared.isEnabled("platform_hosted_enabled")
    }

    var body: some View {
        Text("Hosting")
            .font(.system(size: 32, weight: .regular, design: .serif))
            .foregroundColor(VColor.contentDefault)
            .opacity(showTitle ? 1 : 0)
            .offset(y: showTitle ? 0 : 8)
            .padding(.bottom, VSpacing.md)

        Text("Where do you want your assistant to run?")
            .font(VFont.buttonLarge)
            .foregroundColor(VColor.contentSecondary)
            .opacity(showTitle ? 1 : 0)
            .offset(y: showTitle ? 0 : 8)
            .padding(.bottom, VSpacing.xxl)

        VStack(spacing: VSpacing.md) {
            VStack(spacing: VSpacing.md) {
                hostingCards

                OnboardingButton(
                    title: continueButtonTitle,
                    style: .primary,
                    disabled: !canContinue
                ) {
                    handleContinue()
                }

                OnboardingButton(title: "Need help deciding?", style: .ghostPrimary) {
                    NSWorkspace.shared.open(URL(string: "https://vellum.ai/docs/hosting-options")!)
                }

                if !isAuthenticated {
                    OnboardingButton(title: "Back", style: .ghost) {
                        goBack()
                    }
                    .padding(.top, VSpacing.xs)
                }
            }
        }
        .padding(.horizontal, VSpacing.xxl)
        .opacity(showContent ? 1 : 0)
        .offset(y: showContent ? 0 : 12)
        .onAppear {
            withAnimation(.easeOut(duration: 0.5).delay(0.1)) {
                showTitle = true
            }
            withAnimation(.easeOut(duration: 0.5).delay(0.3)) {
                showContent = true
            }
        }
    }

    // MARK: - Hosting Cards

    private var availableHostingModes: [OnboardingState.HostingMode] {
        var modes: [OnboardingState.HostingMode] = [.local, .vellumCloud]
        // In dev mode, local already uses Docker under the hood, so hide the
        // separate Docker card to reduce confusion. Show "Old Local" instead
        // for legacy non-Docker local development.
        if DevModeManager.shared.isDevMode {
            modes.append(.oldLocal)
        } else {
            modes.insert(.docker, at: 1)
        }
        if userHostedEnabled {
            modes.append(contentsOf: [.aws, .gcp, .customHardware])
        }
        return modes
    }

    private func chipLabel(for mode: OnboardingState.HostingMode) -> String? {
        switch mode {
        case .vellumCloud:
            if state.skippedAuth { return "Requires Account" }
            return platformHostedEnabled ? nil : "Coming Soon"
        case .docker:
            return userHostedEnabled ? nil : "Coming Soon"
        default:
            return nil
        }
    }

    private var hostingCards: some View {
        VStack(spacing: VSpacing.sm) {
            ForEach(availableHostingModes, id: \.rawValue) { mode in
                let subtitle = (DevModeManager.shared.isDevMode && mode == .local)
                    ? OnboardingState.HostingMode.docker.subtitle
                    : mode.subtitle
                hostingCard(
                    icon: iconForMode(mode),
                    title: mode.displayName,
                    subtitle: subtitle,
                    mode: mode,
                    chipLabel: chipLabel(for: mode)
                )
            }
        }
    }

    private func iconForMode(_ mode: OnboardingState.HostingMode) -> VIcon {
        switch mode {
        case .vellumCloud: return .cloud
        case .local: return .laptop
        case .docker: return .package
        case .oldLocal: return .laptop
        case .gcp, .aws: return .globe
        case .customHardware: return .hardDrive
        }
    }

    private func hostingCard(
        icon: VIcon,
        title: String,
        subtitle: String,
        mode: OnboardingState.HostingMode,
        chipLabel: String?
    ) -> some View {
        let isDisabled = chipLabel != nil
        let isSelected = state.selectedHostingMode == mode && !isDisabled

        return Button(action: {
            guard !isDisabled else { return }
            state.selectedHostingMode = mode
        }) {
            HStack(spacing: VSpacing.md) {
                VIconView(icon, size: 18)
                    .foregroundColor(isDisabled ? VColor.contentTertiary : (isSelected ? VColor.primaryBase : VColor.contentSecondary))

                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: VSpacing.sm) {
                        Text(title)
                            .font(.system(size: 15, weight: .medium))
                            .foregroundColor(isDisabled ? VColor.contentTertiary : VColor.contentDefault)

                        Spacer()

                        if let chipLabel {
                            Text(chipLabel)
                                .font(VFont.captionMedium)
                                .foregroundColor(VColor.contentTertiary)
                                .padding(.horizontal, VSpacing.sm)
                                .padding(.vertical, VSpacing.xxs)
                                .background(VColor.surfaceActive)
                                .clipShape(Capsule())
                        }
                    }
                    Text(subtitle)
                        .font(.system(size: 12))
                        .foregroundColor(isDisabled ? VColor.contentTertiary : VColor.contentSecondary)
                }

                if chipLabel == nil {
                    Spacer()

                    Circle()
                        .fill(isSelected ? VColor.primaryBase : Color.clear)
                        .overlay(
                            Circle().stroke(isSelected ? VColor.primaryBase : VColor.borderBase, lineWidth: 1.5)
                        )
                        .overlay(
                            isSelected
                                ? Circle().fill(VColor.auxWhite).frame(width: 6, height: 6)
                                : nil
                        )
                        .frame(width: 18, height: 18)
                }
            }
            .padding(.horizontal, VSpacing.lg)
            .padding(.vertical, VSpacing.md)
            .frame(minHeight: 64)
            .contentShape(Rectangle())
            .background(
                RoundedRectangle(cornerRadius: VRadius.lg)
                    .fill(isSelected ? VColor.primaryBase.opacity(0.1) : Color.clear)
                    .overlay(
                        RoundedRectangle(cornerRadius: VRadius.lg)
                            .stroke(
                                isSelected ? VColor.primaryBase.opacity(0.5)
                                    : (isDisabled ? VColor.borderDisabled : VColor.borderBase),
                                lineWidth: 1
                            )
                    )
            )
            .opacity(isDisabled ? 0.85 : 1.0)
        }
        .buttonStyle(.plain)
        .disabled(isDisabled)
        .pointerCursor()
    }

    // MARK: - Helpers

    private var canContinue: Bool {
        if state.selectedHostingMode == .vellumCloud {
            return platformHostedEnabled && !state.skippedAuth
        }
        return true
    }

    private var continueButtonTitle: String {
        return "Continue"
    }

    private func handleContinue() {
        guard canContinue else { return }

        if state.selectedHostingMode == .oldLocal {
            // "Old Local" bypasses Docker — use the legacy local hatch path.
            state.cloudProvider = OnboardingState.HostingMode.local.rawValue
        } else if DevModeManager.shared.isDevMode && state.selectedHostingMode == .local {
            // In dev mode, "Local" uses Docker under the hood for sandboxed execution.
            state.cloudProvider = OnboardingState.HostingMode.docker.rawValue
        } else {
            state.cloudProvider = state.selectedHostingMode.rawValue
        }

        if isAuthenticated && state.selectedHostingMode == .vellumCloud {
            // Platform-hosted: trigger managed bootstrap directly
            onHatchManaged?()
            return
        }

        if isAuthenticated {
            // Authenticated user selecting Local: skip API key, advance to consent step
            state.selectedProvider = "anthropic"
            state.selectedModel = "claude-opus-4-6"
            saveModelToConfig("claude-opus-4-6")
            state.skippedAPIKeyEntry = true
            state.advance(by: 2)
        } else {
            state.skippedAPIKeyEntry = false
            state.advance()
        }
    }

    private func goBack() {
        withAnimation(.spring(duration: 0.6, bounce: 0.15)) {
            state.currentStep -= 1
        }
    }

    private func saveModelToConfig(_ model: String) {
        let existingConfig = WorkspaceConfigIO.read()
        var services = existingConfig["services"] as? [String: Any] ?? [:]
        var inference = services["inference"] as? [String: Any] ?? [:]
        inference["model"] = model
        services["inference"] = inference
        try? WorkspaceConfigIO.merge(["services": services])
    }
}
