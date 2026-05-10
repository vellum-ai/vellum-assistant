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
            // Show bare-metal local before Docker (experimental).
            let localIndex = modes.firstIndex(of: .local)!
            modes.insert(.oldLocal, at: localIndex)
        }
        if userHostedEnabled {
            modes.append(contentsOf: [.aws, .gcp])
        }
        return modes
    }

    static func displayName(
        for mode: OnboardingState.HostingMode,
        localDockerEnabled: Bool,
        appleContainerEnabled: Bool
    ) -> String {
        if appleContainerEnabled {
            switch mode {
            case .docker: return "Docker Local"
            case .oldLocal: return "Host Local"
            default: return mode.displayName
            }
        }
        if localDockerEnabled {
            switch mode {
            case .local: return "Docker (Experimental)"
            case .oldLocal: return "Local (Bare Metal)"
            default: return mode.displayName
            }
        }
        return mode.displayName
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
            return "Runs locally in a Docker container for added isolation."
        }
        if localDockerEnabled && mode == .oldLocal {
            return "Runs directly on your Mac. No containers, no extra setup."
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
    @State private var showCharacters = false

    private static let welcomeCharacters: NSImage? = {
        guard let url = ResourceBundle.bundle.url(forResource: "welcome-characters", withExtension: "png") else { return nil }
        return NSImage(contentsOf: url)
    }()

    private var userHostedEnabled: Bool {
        MacOSClientFeatureFlagManager.shared.isEnabled("user-hosted-enabled")
    }

    private var localDockerEnabled: Bool {
        MacOSClientFeatureFlagManager.shared.isEnabled("local-docker-enabled")
    }

    private var appleContainerEnabled: Bool {
        AppleContainersAvailabilityChecker.check().isAvailable
    }

    var body: some View {
        Text("Hosting")
            .font(VFont.titleLarge)
            .foregroundStyle(VColor.contentDefault)
            .opacity(showTitle ? 1 : 0)
            .offset(y: showTitle ? 0 : 8)
            .padding(.bottom, VSpacing.md)

        Text("Where do you want your assistant to live?")
            .font(VFont.bodyMediumLighter)
            .foregroundStyle(VColor.contentSecondary)
            .opacity(showTitle ? 1 : 0)
            .offset(y: showTitle ? 0 : 8)
            .padding(.bottom, VSpacing.xxl)

        VStack(spacing: 0) {
            hostingCards

            VStack(spacing: VSpacing.sm) {
                VButton(label: continueButtonTitle, style: .primary, isFullWidth: true, isDisabled: !canContinue) {
                    handleContinue()
                }

                if !isAuthenticated {
                    VButton(label: "Back", style: .outlined, isFullWidth: true) {
                        goBack()
                    }
                }
            }
            .padding(.top, VSpacing.xxl)

            Text("Need help choosing?")
                .font(VFont.bodyMediumDefault)
                .foregroundStyle(VColor.contentDefault)
                .underline()
                .accessibilityAddTraits(.isLink)
                .onTapGesture {
                    NSWorkspace.shared.open(AppURLs.hostingOptionsDocs)
                }
                .pointerCursor()
                .padding(.top, VSpacing.xl)
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

        Spacer()

        if let characters = Self.welcomeCharacters {
            Image(nsImage: characters)
                .resizable()
                .aspectRatio(contentMode: .fit)
                .frame(maxWidth: .infinity)
                .clipShape(UnevenRoundedRectangle(
                    topLeadingRadius: 0,
                    bottomLeadingRadius: VRadius.window,
                    bottomTrailingRadius: VRadius.window,
                    topTrailingRadius: 0
                ))
                .opacity(showCharacters ? 1 : 0)
                .offset(y: showCharacters ? 0 : 30)
                .animation(.easeOut(duration: 0.6).delay(0.5), value: showCharacters)
                .onAppear { showCharacters = true }
                .accessibilityHidden(true)
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
                    localDockerEnabled: localDockerEnabled,
                    appleContainerEnabled: appleContainerEnabled
                )
                let requiresAccount = mode == .vellumCloud && !isAuthenticated
                hostingCard(
                    icon: iconForMode(mode),
                    title: title,
                    subtitle: subtitle,
                    mode: mode,
                    isDisabled: requiresAccount,
                    chipLabel: requiresAccount ? "Requires Account" : nil
                )
            }
        }
    }

    private func iconForMode(_ mode: OnboardingState.HostingMode) -> VIcon {
        switch mode {
        case .vellumCloud: return .cloud
        case .local where localDockerEnabled && !appleContainerEnabled: return .package
        case .local: return .laptop
        case .docker: return .package
        case .oldLocal: return .laptop
        case .gcp, .aws: return .globe
        }
    }

    private func hostingCard(
        icon: VIcon,
        title: String,
        subtitle: String,
        mode: OnboardingState.HostingMode,
        isDisabled: Bool = false,
        chipLabel: String? = nil
    ) -> some View {
        let isSelected = state.selectedHostingMode == mode && !isDisabled

        return Button(action: {
            guard !isDisabled else { return }
            state.selectedHostingMode = mode
        }) {
            HStack(spacing: VSpacing.sm) {
                HStack(spacing: VSpacing.md) {
                    VIconView(icon, size: 14)
                        .foregroundStyle(VColor.contentTertiary)
                        .frame(width: 20, height: 20)

                    VStack(alignment: .leading, spacing: VSpacing.xxs) {
                        HStack(spacing: VSpacing.sm) {
                            Text(title)
                                .font(VFont.bodyMediumEmphasised)
                                .foregroundStyle(isDisabled ? VColor.contentTertiary : VColor.contentEmphasized)
                            if let chipLabel {
                                Text(chipLabel)
                                    .font(VFont.labelDefault)
                                    .foregroundStyle(VColor.contentTertiary)
                                    .padding(.horizontal, VSpacing.sm)
                                    .padding(.vertical, VSpacing.xxs)
                                    .background(VColor.surfaceBase)
                                    .clipShape(Capsule())
                            }
                        }
                        Text(subtitle)
                            .font(VFont.labelDefault)
                            .foregroundStyle(VColor.contentTertiary)
                            .lineLimit(2)
                    }
                }

                Spacer()

                if !isDisabled {
                    Circle()
                        .fill(isSelected ? VColor.primaryBase : Color.clear)
                        .overlay(
                            Circle().stroke(isSelected ? VColor.primaryBase : VColor.borderElement, lineWidth: 1.5)
                        )
                        .overlay(
                            isSelected
                                ? Circle().fill(VColor.auxWhite).frame(width: 6, height: 6)
                                : nil
                        )
                        .frame(width: 16, height: 16)
                }
            }
            .padding(VSpacing.md)
            .frame(height: 72)
            .contentShape(Rectangle())
            .background(
                RoundedRectangle(cornerRadius: VRadius.lg)
                    .fill(isSelected ? VColor.primaryBase.opacity(0.05) : Color.clear)
                    .overlay(
                        RoundedRectangle(cornerRadius: VRadius.lg)
                            .stroke(
                                isSelected ? VColor.primaryBase.opacity(0.5) : VColor.borderDisabled,
                                lineWidth: 1
                            )
                    )
            )
        }
        .buttonStyle(.plain)
        .disabled(isDisabled)
        .opacity(isDisabled ? 0.7 : 1.0)
        .pointerCursor()
    }

    // MARK: - Helpers

    private var canContinue: Bool {
        if state.selectedHostingMode == .vellumCloud {
            return isAuthenticated
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
            state.selectedProvider = LLMProviderRegistry.defaultProvider?.id ?? "anthropic"
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
