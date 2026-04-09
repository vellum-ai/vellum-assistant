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
            .font(VFont.titleSmall)
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
                    appleContainerEnabled: appleContainerEnabled
                )
                hostingCard(
                    icon: iconForMode(mode),
                    title: title,
                    subtitle: subtitle,
                    mode: mode
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
        mode: OnboardingState.HostingMode
    ) -> some View {
        let isSelected = state.selectedHostingMode == mode

        return Button(action: {
            state.selectedHostingMode = mode
        }) {
            HStack(spacing: VSpacing.sm) {
                HStack(spacing: VSpacing.md) {
                    VIconView(icon, size: 14)
                        .foregroundStyle(VColor.contentTertiary)
                        .frame(width: 20, height: 20)

                    VStack(alignment: .leading, spacing: VSpacing.xxs) {
                        Text(title)
                            .font(VFont.bodyMediumEmphasised)
                            .foregroundStyle(VColor.contentEmphasized)
                        Text(subtitle)
                            .font(VFont.labelDefault)
                            .foregroundStyle(VColor.contentTertiary)
                            .lineLimit(2)
                    }
                }

                Spacer()

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
