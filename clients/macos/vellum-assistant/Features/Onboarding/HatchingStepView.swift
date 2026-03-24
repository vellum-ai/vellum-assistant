import VellumAssistantShared
import SwiftUI
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "HatchingStepView")

@MainActor
struct HatchingStepView: View {
    @Bindable var state: OnboardingState

    @State private var cliLauncher = VellumCli()
    @State private var showContent = false
    @State private var characterAwake = false
    @State private var pulseScale: CGFloat = 0.9
    @State private var showCharacter = true
    @State private var hatchStarted = false
    @State private var failureReason: String?
    private var hatchBody: AvatarBodyShape {
        state.hatchAvatarBodyShape ?? .allCases[0]
    }
    private var hatchEyes: AvatarEyeStyle {
        state.hatchAvatarEyeStyle ?? .allCases[0]
    }
    private var hatchColor: AvatarColor {
        state.hatchAvatarColor ?? .allCases[0]
    }
    @State private var completionTask: Task<Void, Never>?

    var body: some View {
        VStack(spacing: VSpacing.lg) {
            Spacer()

            characterAnimation
                .padding(.bottom, VSpacing.xl)

            statusText

            if state.hatchFailed {
                failureButtons
            }

            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .opacity(showContent ? 1 : 0)
        .onAppear {
            // Eagerly initialize avatar traits so computed getters don't
            // mutate @Observable state during body evaluation.
            if state.hatchAvatarBodyShape == nil {
                state.hatchAvatarBodyShape = .allCases.randomElement()!
            }
            if state.hatchAvatarEyeStyle == nil {
                state.hatchAvatarEyeStyle = .allCases.randomElement()!
            }
            if state.hatchAvatarColor == nil {
                state.hatchAvatarColor = .allCases.randomElement()!
            }

            withAnimation(.easeOut(duration: 0.5)) {
                showContent = true
            }
            startPulse()
            if !hatchStarted {
                hatchStarted = true
                startHatching()
            }
        }
        .onDisappear {
            completionTask?.cancel()
        }
        .onChange(of: state.hatchCompleted) { _, completed in
            if completed {
                characterAwake = true
            }
        }
        .onChange(of: state.hatchFailed) { _, failed in
            if failed {
                // Stop the pulse animation and fade out the character
                // so it doesn't keep pulsing behind the error text.
                withAnimation(.easeOut(duration: 0.3)) {
                    showCharacter = false
                }
            }
        }
    }

    // MARK: - Avatar

    private var hatchAvatarImage: NSImage? {
        AvatarCompositor.render(bodyShape: hatchBody, eyeStyle: hatchEyes, color: hatchColor)
    }

    // MARK: - Character Animation

    private var characterAnimation: some View {
        ZStack {
            if let image = hatchAvatarImage {
                Image(nsImage: image)
                    .resizable()
                    .aspectRatio(contentMode: .fit)
                    .frame(width: 100, height: 100)
                    .scaleEffect(characterAwake ? 1.1 : pulseScale)
                    .opacity(showCharacter ? (characterAwake ? 1.0 : 0.6) : 0)
                    .animation(.spring(duration: 0.6, bounce: 0.3), value: characterAwake)
                    .accessibilityHidden(true)
            }
        }
        .frame(width: 120, height: 120)
    }

    private func startPulse() {
        withAnimation(.easeInOut(duration: 1.2).repeatForever(autoreverses: true)) {
            pulseScale = 1.0
        }
    }

    // MARK: - Status Text

    private var isCustomHardware: Bool {
        state.cloudProvider == "customHardware"
    }

    private var statusText: some View {
        VStack(spacing: VSpacing.sm) {
            if state.hatchFailed {
                if state.hasExistingManagedAssistant {
                    Text("You already have an assistant")
                        .font(.system(size: 24, weight: .regular, design: .serif))
                        .foregroundColor(VColor.contentDefault)
                    Text("You have an assistant on the hosted platform")
                        .font(.system(size: 14))
                        .foregroundColor(VColor.contentSecondary)
                } else {
                    Text("Something went wrong")
                        .font(.system(size: 24, weight: .regular, design: .serif))
                        .foregroundColor(VColor.contentDefault)
                    if let reason = failureReason {
                        Text(reason)
                            .font(.system(size: 14))
                            .foregroundColor(VColor.contentSecondary)
                            .textSelection(.enabled)
                    }
                }
            } else if state.hatchCompleted {
                Text(isCustomHardware ? "Your assistant is paired!" : "Your assistant is ready!")
                    .font(.system(size: 24, weight: .regular, design: .serif))
                    .foregroundColor(VColor.contentDefault)
            } else if isCustomHardware {
                Text("Pairing\u{2026}")
                    .font(.system(size: 24, weight: .regular, design: .serif))
                    .foregroundColor(VColor.contentDefault)
            } else {
                Text("Waking up...")
                    .font(.system(size: 24, weight: .regular, design: .serif))
                    .foregroundColor(VColor.contentDefault)
                Text("Hang tight \u{2014} your assistant will have a few\nquestions for you once it\u{2019}s up.")
                    .font(.system(size: 13))
                    .foregroundColor(VColor.contentTertiary)
                    .multilineTextAlignment(.center)
            }
        }
        .multilineTextAlignment(.center)
        .frame(maxWidth: 320)
    }

    // MARK: - Failure Buttons

    private var failureButtons: some View {
        VStack(spacing: VSpacing.sm) {
            if state.hasExistingManagedAssistant {
                OnboardingButton(title: "Meet your assistant", style: .primary) {
                    meetExistingAssistant()
                }

                OnboardingButton(title: "Go Back", style: .ghost) {
                    goBack()
                }
            } else {
                OnboardingButton(title: "Try Again", style: .primary) {
                    retryHatch()
                }

                OnboardingButton(title: "Go Back", style: .ghost) {
                    goBack()
                }
            }
        }
        .frame(maxWidth: 280)
        .padding(.top, VSpacing.xs)
    }

    private func goBack() {
        state.isHatching = false
        state.isManagedHatch = false
        state.hasExistingManagedAssistant = false
        state.hatchFailed = false
        state.hatchLogLines = []
        state.hatchProgressTarget = 0.0
        state.hatchProgressDisplay = 0.0
        state.hatchStepLabel = nil
        state.hatchTotalSteps = 1
        state.hatchCurrentStep = 0
        hatchStarted = false
        failureReason = nil
    }

    private func meetExistingAssistant() {
        state.hatchFailed = false
        state.hatchCompleted = true
    }

    private func retryHatch() {
        hatchStarted = false
        failureReason = nil
        state.resetForRetry()
    }

    /// Called when the CLI process finishes successfully or when the success
    /// sentinel is detected in CLI output. Saves the random avatar (for
    /// non-pairing flows) then signals completion after a brief delay.
    /// Idempotent — safe to call multiple times.
    private func handleHatchSuccess() {
        guard !state.hatchCompleted && !state.hatchFailed && completionTask == nil else { return }

        log.info("Hatch success detected — starting completion transition")

        // Save the randomly-generated avatar as the user's avatar, but only for
        // non-pairing flows and only if one hasn't already been uploaded/generated
        // (preserves existing avatars when replaying onboarding during development).
        if !isCustomHardware,
           AvatarAppearanceManager.shared.customAvatarImage == nil,
           let image = hatchAvatarImage {
            AvatarAppearanceManager.shared.saveAvatar(image, bodyShape: hatchBody, eyeStyle: hatchEyes, color: hatchColor)
        }

        // Brief delay so the user sees the waking animation before transition.
        // Stored as a cancellable Task so it's cleaned up if the view disappears.
        completionTask = Task {
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            guard !Task.isCancelled else { return }
            state.hatchCompleted = true
        }
    }

    // MARK: - Hatching / Pairing

    private func startHatching() {
        // Managed assistants handle daemon connection in OnboardingFlowView;
        // this view only provides the animation and failure UI.
        if state.isManagedHatch { return }
        if isCustomHardware {
            startPairing()
        } else {
            startRemoteHatch()
        }
    }

    /// Sentinel string emitted by the CLI when Docker containers are ready.
    /// Detecting this in output lets the desktop app proceed even when the
    /// CLI process stays alive (e.g. `--watch` mode in DEBUG builds).
    private static let dockerReadySentinel = "Docker containers are up and running"

    /// Build the --config key=value pairs for the onboarding inference selection.
    private func buildOnboardingConfigValues() -> [String: String] {
        var configValues: [String: String] = [:]
        if !state.selectedProvider.isEmpty {
            configValues["services.inference.provider"] = state.selectedProvider
        }
        if !state.selectedModel.isEmpty {
            configValues["services.inference.model"] = state.selectedModel
        }
        return configValues
    }

    private func startRemoteHatch() {
        var providerApiKeys: [String: String] = [:]
        if let envVar = VellumCli.providerEnvVars[state.selectedProvider],
           let key = APIKeyManager.getKey(for: state.selectedProvider),
           !key.isEmpty {
            providerApiKeys[envVar] = key
        }

        let config = VellumCli.RemoteHatchConfig(
            remote: state.cloudProvider,
            gcpProjectId: state.gcpProjectId,
            gcpZone: state.gcpZone,
            gcpServiceAccountKey: state.gcpServiceAccountKey,
            awsRoleArn: state.awsRoleArn,
            sshHost: state.sshHost,
            sshUser: state.sshUser,
            sshPrivateKey: state.sshPrivateKey,
            providerApiKeys: providerApiKeys,
            configValues: buildOnboardingConfigValues()
        )

        Task {
            do {
                try await cliLauncher.runRemoteHatch(config: config) { line in
                    Task { @MainActor in
                        log.info("CLI hatch output: \(line, privacy: .public)")
                        state.hatchLogLines.append(line)

                        // Detect the readiness sentinel from CLI output so we
                        // don't have to wait for the CLI process to exit (which
                        // never happens in --watch mode).
                        if line.contains(Self.dockerReadySentinel) {
                            handleHatchSuccess()
                        }
                    }
                }
                log.info("CLI hatch process exited")
                handleHatchSuccess()
            } catch {
                log.error("Remote hatch failed: \(String(describing: error), privacy: .public)")
                state.hatchLogLines.append("Error: \(error.localizedDescription)")
                failureReason = friendlyErrorMessage(from: error)
                state.hatchFailed = true
            }
        }
    }

    private func startPairing() {
        Task {
            do {
                try await cliLauncher.runPair(qrCodeImageData: state.customQRCodeImageData) { line in
                    Task { @MainActor in
                        state.hatchLogLines.append(line)
                    }
                }
                handleHatchSuccess()
            } catch {
                log.error("Pairing failed: \(String(describing: error), privacy: .public)")
                state.hatchLogLines.append("Error: \(error.localizedDescription)")
                failureReason = friendlyErrorMessage(from: error)
                state.hatchFailed = true
            }
        }
    }

    // MARK: - Error Mapping

    private func friendlyErrorMessage(from error: Error) -> String {
        let desc = error.localizedDescription.lowercased()
        if desc.contains("connection refused") || desc.contains("econnrefused") {
            return "Could not connect to your assistant"
        } else if desc.contains("timed out") || desc.contains("timeout") {
            return "Setup timed out \u{2014} please try again"
        } else if desc.contains("no such file") || desc.contains("enoent") {
            return "Assistant files could not be found"
        } else if desc.contains("network") || desc.contains("internet") {
            return "Network connection issue"
        } else if desc.contains("permission") || desc.contains("eacces") {
            return "Permission denied"
        } else {
            return error.localizedDescription
        }
    }
}
