import VellumAssistantShared
import SwiftUI
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "HatchingStepView")

@MainActor
struct HatchingStepView: View {
    @Bindable var state: OnboardingState

    @State private var cliLauncher = AssistantCli()
    @State private var showContent = false
    @State private var characterAwake = false
    @State private var pulseScale: CGFloat = 0.9
    @State private var showCharacter = true
    @State private var hatchStarted = false
    @State private var failureReason: String?
    @State private var hatchBody = AvatarBodyShape.allCases.randomElement()!
    @State private var hatchEyes = AvatarEyeStyle.allCases.randomElement()!
    @State private var hatchColor = AvatarColor.allCases.randomElement()! // color-literal-ok
    @State private var completionTask: Task<Void, Never>?
    @State private var hatchTask: Task<Void, Never>?

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
            hatchTask?.cancel()
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

    private var isAppleContainersHatch: Bool {
        state.selectedRuntimeBackend == .appleContainers
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
            } else if isAppleContainersHatch {
                Text("Starting container\u{2026}")
                    .font(.system(size: 24, weight: .regular, design: .serif))
                    .foregroundColor(VColor.contentDefault)
                Text("Setting up your assistant in an Apple Container\u{2026}")
                    .font(.system(size: 14))
                    .foregroundColor(VColor.contentSecondary)
                // Surface the most recent pod runtime progress line if any.
                if let latestLine = state.hatchLogLines.last {
                    Text(latestLine)
                        .font(.system(size: 12))
                        .foregroundColor(VColor.contentTertiary)
                        .lineLimit(2)
                        .multilineTextAlignment(.center)
                }
                Text("This may take a few minutes while images are pulled.")
                    .font(.system(size: 13))
                    .foregroundColor(VColor.contentTertiary)
            } else {
                Text("Waking up...")
                    .font(.system(size: 24, weight: .regular, design: .serif))
                    .foregroundColor(VColor.contentDefault)
                Text("Getting your assistant ready\u{2026}")
                    .font(.system(size: 14))
                    .foregroundColor(VColor.contentSecondary)
                Text("Your assistant will ask a few quick questions to get started.\nThis usually takes less than a minute.")
                    .font(.system(size: 13))
                    .foregroundColor(VColor.contentTertiary)
            }
        }
    }

    // MARK: - Failure Buttons

    private var failureButtons: some View {
        VStack(spacing: VSpacing.sm) {
            if state.hasExistingManagedAssistant {
                OnboardingButton(title: "Meet your assistant", style: .primary) {
                    meetExistingAssistant()
                }

                OnboardingButton(title: "Go Back", style: .tertiary) {
                    goBack()
                }
            } else {
                OnboardingButton(title: "Try Again", style: .primary) {
                    retryHatch()
                }

                OnboardingButton(title: "Go Back", style: .tertiary) {
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

    /// Called when the CLI process finishes successfully. Saves the random avatar
    /// (for non-pairing flows) then signals completion after a brief delay.
    private func handleHatchSuccess() {
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
        } else if isAppleContainersHatch {
            startAppleContainersHatch()
        } else {
            startRemoteHatch()
        }
    }

    private func startAppleContainersHatch() {
        // Use the AppDelegate-owned launcher so the active pod is tracked by
        // AppDelegate.applicationWillTerminate and cleaned up on app exit.
        // Creating a local instance here would leave an orphaned VM running
        // after the user quits.
        let launcher = AppDelegate.shared?.appleContainersLauncher
        hatchTask = Task {
            do {
                state.hatchLogLines.append("Preparing kernel images\u{2026}")
                guard !Task.isCancelled else { return }

                // AppleContainersLauncher writes its own lockfile entry and manages
                // the full pod lifecycle; we just need to wait for it to finish.
                state.hatchLogLines.append("Starting pod\u{2026}")
                try await launcher?.launch(name: nil, daemonOnly: false, restart: false)
                guard !Task.isCancelled else { return }

                state.hatchLogLines.append("Waiting for gateway\u{2026}")
                handleHatchSuccess()
            } catch {
                guard !Task.isCancelled else { return }
                log.error("Apple Containers hatch failed: \(String(describing: error), privacy: .public)")
                failureReason = friendlyErrorMessage(from: error)
                state.hatchFailed = true
            }
        }
    }

    private func startRemoteHatch() {
        let apiKey = APIKeyManager.getKey(for: "anthropic") ?? ""

        let config = AssistantCli.RemoteHatchConfig(
            remote: state.cloudProvider,
            gcpProjectId: state.gcpProjectId,
            gcpZone: state.gcpZone,
            gcpServiceAccountKey: state.gcpServiceAccountKey,
            awsRoleArn: state.awsRoleArn,
            sshHost: state.sshHost,
            sshUser: state.sshUser,
            sshPrivateKey: state.sshPrivateKey,
            anthropicApiKey: apiKey
        )

        Task {
            do {
                try await cliLauncher.runRemoteHatch(config: config) { line in
                    Task { @MainActor in
                        state.hatchLogLines.append(line)
                    }
                }
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

#Preview {
    ZStack {
        VColor.surfaceOverlay.ignoresSafeArea()
        HatchingStepView(state: {
            let s = OnboardingState()
            s.isHatching = true
            s.cloudProvider = "gcp"
            return s
        }())
    }
    .frame(width: 460, height: 620)
}
