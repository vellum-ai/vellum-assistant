import VellumAssistantShared
import SwiftUI

enum OnboardingHostingModeResolver {
    static func availableHostingModes(
        userHostedEnabled: Bool,
        localDockerEnabled: Bool,
        appleContainerEnabled: Bool
    ) -> [OnboardingState.HostingMode] {
        var modes: [OnboardingState.HostingMode] = [.vellumCloud, .local]
        if appleContainerEnabled {
            // Apple Container is the new "Local" default; expose Docker
            // and bare-host local as separate fallback options.
            modes.append(contentsOf: [.docker, .oldLocal])
        } else if localDockerEnabled {
            // Keep "Local" as the default choice and expose the legacy
            // non-Docker hatch explicitly as an escape hatch.
            modes.append(.oldLocal)
        }
        if userHostedEnabled {
            modes.append(contentsOf: [.aws, .gcp, .customHardware])
        }
        return modes
    }

    static func displayName(
        for mode: OnboardingState.HostingMode,
        appleContainerEnabled: Bool
    ) -> String {
        guard appleContainerEnabled else { return mode.displayName }
        switch mode {
        case .docker: return "Docker Local"
        case .oldLocal: return "Host Local"
        default: return mode.displayName
        }
    }

    static func subtitle(
        for mode: OnboardingState.HostingMode,
        localDockerEnabled: Bool,
        appleContainerEnabled: Bool
    ) -> String {
        if appleContainerEnabled && mode == .local {
            return "Native macOS sandbox. Your machine, your data, fully isolated."
        }
        if localDockerEnabled && mode == .local {
            return OnboardingState.HostingMode.docker.subtitle
        }
        return mode.subtitle
    }

    static func cloudProvider(
        for mode: OnboardingState.HostingMode,
        localDockerEnabled: Bool,
        appleContainerEnabled: Bool
    ) -> String {
        switch mode {
        case .oldLocal:
            return OnboardingState.HostingMode.local.rawValue
        case .local where appleContainerEnabled:
            return "apple-container"
        case .local where localDockerEnabled:
            return OnboardingState.HostingMode.docker.rawValue
        default:
            return mode.rawValue
        }
    }
}

@MainActor
struct APIKeyStepView: View {
    @Bindable var state: OnboardingState
    var isAuthenticated: Bool = false
    var onHatchManaged: (() -> Void)?

    @State private var showTitle = false
    @State private var showContent = false

    private var userHostedEnabled: Bool {
        MacOSClientFeatureFlagManager.shared.isEnabled("user-hosted-enabled")
    }

    private var localDockerEnabled: Bool {
        MacOSClientFeatureFlagManager.shared.isEnabled("local-docker-enabled")
    }

    private var appleContainerEnabled: Bool {
        MacOSClientFeatureFlagManager.shared.isEnabled("apple-container")
    }

    var body: some View {
        Text("Hosting")
            .font(VFont.displayLarge)
            .foregroundStyle(VColor.contentDefault)
            .opacity(showTitle ? 1 : 0)
            .offset(y: showTitle ? 0 : 8)
            .padding(.bottom, VSpacing.md)

        Text("Where do you want your assistant to run?")
            .font(VFont.titleSmall)
            .foregroundStyle(VColor.contentSecondary)
            .opacity(showTitle ? 1 : 0)
            .offset(y: showTitle ? 0 : 8)
            .padding(.bottom, VSpacing.xxl)

        VStack(spacing: VSpacing.md) {
            VStack(spacing: VSpacing.md) {
                hostingCards

                VButton(label: continueButtonTitle, style: .primary, isFullWidth: true, isDisabled: !canContinue) {
                    handleContinue()
                }

                VButton(label: "Need help deciding?", style: .ghost) {
                    NSWorkspace.shared.open(URL(string: "https://vellum.ai/docs/hosting-options")!)
                }

                if !isAuthenticated {
                    VButton(label: "Back", style: .ghost) {
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
        OnboardingHostingModeResolver.availableHostingModes(
            userHostedEnabled: userHostedEnabled,
            localDockerEnabled: localDockerEnabled,
            appleContainerEnabled: appleContainerEnabled
        )
    }

    private func chipLabel(for mode: OnboardingState.HostingMode) -> String? {
        switch mode {
        case .vellumCloud:
            if !isAuthenticated { return "Requires Account" }
            return nil
        default:
            return nil
        }
    }

    private var hostingCards: some View {
        VStack(spacing: VSpacing.sm) {
            ForEach(availableHostingModes, id: \.rawValue) { mode in
                let subtitle = OnboardingHostingModeResolver.subtitle(
                    for: mode,
                    localDockerEnabled: localDockerEnabled,
                    appleContainerEnabled: appleContainerEnabled
                )
                let title = OnboardingHostingModeResolver.displayName(
                    for: mode,
                    appleContainerEnabled: appleContainerEnabled
                )
                hostingCard(
                    icon: iconForMode(mode),
                    title: title,
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
                    .foregroundStyle(isDisabled ? VColor.contentTertiary : (isSelected ? VColor.primaryBase : VColor.contentSecondary))

                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: VSpacing.sm) {
                        Text(title)
                            .font(VFont.bodyLargeEmphasised)
                            .foregroundStyle(isDisabled ? VColor.contentTertiary : VColor.contentDefault)

                        Spacer()

                        if let chipLabel {
                            Text(chipLabel)
                                .font(VFont.labelDefault)
                                .foregroundStyle(VColor.contentTertiary)
                                .padding(.horizontal, VSpacing.sm)
                                .padding(.vertical, VSpacing.xxs)
                                .background(VColor.surfaceActive)
                                .clipShape(Capsule())
                        }
                    }
                    Text(subtitle)
                        .font(VFont.bodySmallDefault)
                        .foregroundStyle(isDisabled ? VColor.contentTertiary : VColor.contentSecondary)
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
            .frame(minHeight: 80)
            .contentShape(Rectangle())
            .background(
                RoundedRectangle(cornerRadius: VRadius.xl)
                    .fill(isSelected ? VColor.primaryBase.opacity(0.1) : Color.clear)
                    .overlay(
                        RoundedRectangle(cornerRadius: VRadius.xl)
                            .stroke(
                                isSelected ? VColor.primaryBase.opacity(0.5)
                                    : (isDisabled ? VColor.borderDisabled : VColor.borderBase),
                                lineWidth: 2
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
            return isAuthenticated && !state.skippedAuth
        }
        return true
    }

    private var continueButtonTitle: String {
        return "Continue"
    }

    private func handleContinue() {
        guard canContinue else { return }

        state.cloudProvider = OnboardingHostingModeResolver.cloudProvider(
            for: state.selectedHostingMode,
            localDockerEnabled: localDockerEnabled,
            appleContainerEnabled: appleContainerEnabled
        )

        if isAuthenticated {
            // Authenticated user: skip API key entry, advance to consent step
            state.selectedProvider = "anthropic"
            state.selectedModel = "claude-opus-4-6"
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

}
