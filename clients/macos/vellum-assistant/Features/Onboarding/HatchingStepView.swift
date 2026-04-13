import VellumAssistantShared
import SwiftUI
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "HatchingStepView")

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
    private var managedSignInEnabled: Bool {
        MacOSClientFeatureFlagManager.shared.isEnabled("managed-sign-in")
    }
    @State private var showFooterCharacters = false
    @State private var completionTask: Task<Void, Never>?
    @State private var isAnimatingProgress: Bool = false
    @State private var progressStartTime: CFAbsoluteTime?
    @State private var completionTime: Date?
    @State private var progressAtCompletion: Double?

    var body: some View {
        VStack(spacing: VSpacing.lg) {
            Color.clear.frame(height: VSpacing.xxl)

            statusText

            Spacer()

            characterAnimation

            Spacer()

            if showProgressBar {
                progressSection
            }

            if state.hatchFailed {
                failureButtons
            }

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
                    .opacity(showFooterCharacters ? 1 : 0)
                    .offset(y: showFooterCharacters ? 0 : 30)
                    .animation(.easeOut(duration: 0.6).delay(0.5), value: showFooterCharacters)
                    .onAppear { showFooterCharacters = true }
                    .accessibilityHidden(true)
            }
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

            // In the managed path, hatchStepLabel is set before HatchingStepView
            // appears, so .onChange(of: hatchStepLabel) never fires. Start the
            // progress timer eagerly when the label is already present.
            if state.hatchStepLabel != nil {
                progressStartTime = CFAbsoluteTimeGetCurrent()
                isAnimatingProgress = true
            }
        }
        .onDisappear {
            completionTask?.cancel()
            isAnimatingProgress = false
        }
        .onChange(of: state.hatchStepLabel) { oldLabel, newLabel in
            if oldLabel == nil, newLabel != nil {
                progressStartTime = CFAbsoluteTimeGetCurrent()
                isAnimatingProgress = true
            }
        }
        .onChange(of: state.hatchCompleted) { _, completed in
            if completed {
                characterAwake = true
                // Capture state for the completion ramp animation
                if completionTime == nil {
                    progressAtCompletion = progressValue(at: Date())
                    completionTime = Date()
                }
            }
        }
        .onChange(of: state.hatchFailed) { _, failed in
            if failed {
                // Stop the pulse animation but keep the character visible.
                withAnimation(.easeOut(duration: 0.3)) {
                    pulseScale = 1.0
                }
            }
        }
    }

    private static let welcomeCharacters: NSImage? = {
        guard let url = ResourceBundle.bundle.url(forResource: "welcome-characters", withExtension: "png") else { return nil }
        return NSImage(contentsOf: url)
    }()

    // MARK: - Avatar

    private var hatchAvatarImage: NSImage? {
        AvatarCompositor.render(bodyShape: hatchBody, eyeStyle: hatchEyes, color: hatchColor)
    }

    private var failureAvatarImage: NSImage? {
        AvatarCompositor.render(
            bodyShape: hatchBody,
            eyeStyle: hatchEyes,
            color: hatchColor,
            overrideBodyColor: NSColor(VColor.contentDisabled)
        )
    }

    // MARK: - Character Animation

    private var characterAnimation: some View {
        ZStack {
            if let image = state.hatchFailed ? failureAvatarImage : hatchAvatarImage {
                Image(nsImage: image)
                    .resizable()
                    .aspectRatio(contentMode: .fit)
                    .frame(width: 122, height: 125)
                    .rotationEffect(state.hatchFailed ? .degrees(45) : .zero)
                    .scaleEffect(characterAwake ? 1.1 : pulseScale)
                    .opacity(showCharacter ? (state.hatchFailed ? 1.0 : (characterAwake ? 1.0 : 0.6)) : 0)
                    .animation(.spring(duration: 0.6, bounce: 0.3), value: characterAwake)
                    .animation(.easeOut(duration: 0.4), value: state.hatchFailed)
                    .accessibilityHidden(true)
            }
        }
        .frame(width: 140, height: 140)
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
                        .font(VFont.titleLarge)
                        .foregroundStyle(VColor.contentDefault)
                    Text("You have an assistant on the hosted platform")
                        .font(VFont.bodyMediumDefault)
                        .foregroundStyle(VColor.contentSecondary)
                } else {
                    Text("Something went wrong")
                        .font(VFont.titleLarge)
                        .foregroundStyle(VColor.contentDefault)
                    if let reason = failureReason {
                        Text(reason)
                            .font(VFont.bodyMediumDefault)
                            .foregroundStyle(VColor.contentSecondary)
                            .textSelection(.enabled)
                    }
                }
            } else if state.hatchCompleted {
                Text(isCustomHardware ? "Your assistant is paired!" : "Your assistant is ready!")
                    .font(VFont.titleLarge)
                    .foregroundStyle(VColor.contentDefault)
            } else if isCustomHardware {
                Text("Pairing\u{2026}")
                    .font(VFont.titleLarge)
                    .foregroundStyle(VColor.contentDefault)
            } else {
                Text("Waking up...")
                    .font(VFont.titleLarge)
                    .foregroundStyle(VColor.contentDefault)
                Text("Hang tight - your assistant will have a few questions for you once it's up.")
                    .font(VFont.bodyMediumLighter)
                    .foregroundStyle(VColor.contentSecondary)
                    .multilineTextAlignment(.center)
            }
        }
        .multilineTextAlignment(.center)
        .frame(maxWidth: 320)
    }

    // MARK: - Progress Bar

    private var showProgressBar: Bool {
        !state.hatchFailed && !isCustomHardware && state.hatchStepLabel != nil
            && (!state.hatchCompleted || isAnimatingProgress)
    }

    private var progressSection: some View {
        VStack(spacing: VSpacing.lg) {
            TimelineView(.animation) { context in
                let progress = progressValue(at: context.date)
                GeometryReader { geo in
                    ZStack(alignment: .leading) {
                        Capsule()
                            .fill(VColor.surfaceBase)
                            .frame(height: 6)
                        Capsule()
                            .fill(VColor.primaryBase)
                            .frame(width: geo.size.width * progress, height: 6)
                    }
                }
                .frame(maxWidth: 200, maxHeight: 6)
                .accessibilityElement()
                .accessibilityValue("\(Int(progress * 100)) percent")
                .accessibilityLabel("Setup progress")
            }
            if let label = state.hatchStepLabel {
                Text(label)
                    .font(VFont.labelSmall)
                    .foregroundStyle(VColor.contentTertiary)
            }
        }
        .transition(.opacity.animation(.easeOut(duration: 0.3)))
    }

    // MARK: - Failure Buttons

    private var failureButtons: some View {
        VStack(spacing: VSpacing.sm) {
            if state.hasExistingManagedAssistant {
                VButton(label: "Meet your assistant", style: .primary, isFullWidth: true) {
                    meetExistingAssistant()
                }

                VButton(label: "Go Back", style: .ghost) {
                    goBack()
                }
            } else {
                VButton(label: "Try Again", style: .primary, isFullWidth: true) {
                    retryHatch()
                }

                VButton(label: "Back", style: .outlined, isFullWidth: true) {
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
            try? await Task.sleep(nanoseconds: 500_000_000)
            guard !Task.isCancelled else { return }
            state.hatchCompleted = true
        }
    }

    // MARK: - Progress Calculation

    /// Estimated hatch duration per hosting mode, used to pace the progress bar.
    /// The bar uses an asymptotic curve so it never stalls even if the actual
    /// duration exceeds this estimate — it just moves more slowly.
    private var estimatedDuration: TimeInterval {
        switch state.cloudProvider {
        case "local": return 10
        case "apple-container": return 30
        case "docker": return 120
        case "gcp", "aws": return 300
        default: return 60
        }
    }

    /// Computes the progress bar value for the given point in time.
    /// Called from within `TimelineView(.animation)` so it runs at display refresh rate.
    private func progressValue(at date: Date) -> Double {
        guard state.hatchStepLabel != nil, let startTime = progressStartTime else { return 0 }

        if state.hatchCompleted, let compTime = completionTime, let baseProgress = progressAtCompletion {
            // Ease-out ramp from current position to 100%
            let timeSinceCompletion = date.timeIntervalSince(compTime)
            let rampProgress = min(1.0, 1.0 - exp(-timeSinceCompletion * 3.0))
            let value = baseProgress + (1.0 - baseProgress) * rampProgress
            if value >= 0.999 {
                // Stop the animation once the ramp is effectively complete
                Task { @MainActor in
                    isAnimatingProgress = false
                }
                return 1.0
            }
            return value
        }

        if state.hatchFailed {
            // Freeze at the last computed asymptotic value
            let elapsed = CFAbsoluteTimeGetCurrent() - startTime
            return 0.95 * (1.0 - exp(-elapsed / estimatedDuration))
        }

        // Asymptotic time-based progress: 0.95 * (1 - e^(-t/estimated))
        // Never reaches 95% no matter how long — always appears to be moving.
        // estimatedDuration controls the pace: at 1x estimate the bar is ~60%.
        let elapsed = CFAbsoluteTimeGetCurrent() - startTime
        return 0.95 * (1.0 - exp(-elapsed / estimatedDuration))
    }

    // MARK: - Hatching / Pairing

    private func startHatching() {
        // Managed assistants handle daemon connection in OnboardingFlowView;
        // this view only provides the animation and failure UI.
        if state.isManagedHatch { return }
        if state.cloudProvider == "apple-container" {
            startAppleContainerHatch()
        } else if isCustomHardware {
            startPairing()
        } else {
            startRemoteHatch()
        }
    }

    private func startAppleContainerHatch() {
        guard #available(macOS 26.0, *),
              let launcher = AppDelegate.shared?.appleContainersLauncher as? AppleContainersLauncher else {
            log.error("AppleContainersLauncher not available on AppDelegate")
            state.hatchFailed = true
            return
        }

        let configValues = buildOnboardingConfigValues()

        Task {
            do {
                state.hatchLogLines.append("Starting Apple Container hatch...")
                try await launcher.hatch(
                    name: state.assistantName.isEmpty ? nil : state.assistantName,
                    configValues: configValues,
                    progress: { message in
                        self.state.hatchLogLines.append(message)
                        self.state.hatchStepLabel = message
                    }
                )
                log.info("Apple container hatch succeeded")
                handleHatchSuccess()
            } catch {
                log.error("Apple container hatch failed: \(error.localizedDescription, privacy: .public)")
                state.hatchLogLines.append("Error: \(error.localizedDescription)")
                failureReason = error.localizedDescription
                state.hatchFailed = true
            }
        }
    }

    /// Sentinel string emitted by the CLI when Docker containers are ready.
    /// Detecting this in output lets the desktop app proceed even when the
    /// CLI process stays alive (e.g. `--watch` mode in DEBUG builds).
    private static let dockerReadySentinel = "Docker containers are up and running"

    /// Build the --config key=value pairs for the onboarding selections.
    /// When managed sign-in is enabled and the user did not skip auth, set all
    /// services to managed mode so they route through the platform proxy.
    private func buildOnboardingConfigValues() -> [String: String] {
        var configValues: [String: String] = [:]
        if !state.selectedProvider.isEmpty {
            configValues["services.inference.provider"] = state.selectedProvider
        }
        if !state.selectedModel.isEmpty {
            configValues["services.inference.model"] = state.selectedModel
        }
        if managedSignInEnabled && !state.skippedAuth {
            configValues["services.inference.mode"] = "managed"
            configValues["services.image-generation.mode"] = "managed"
            configValues["services.web-search.mode"] = "managed"
            configValues["services.google-oauth.mode"] = "managed"
            configValues["services.outlook-oauth.mode"] = "managed"
            configValues["services.linear-oauth.mode"] = "managed"
            configValues["services.github-oauth.mode"] = "managed"
            configValues["services.notion-oauth.mode"] = "managed"
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

                        // Parse progress sentinel
                        if line.hasPrefix("HATCH_PROGRESS:") {
                            // Ignore late events after success
                            guard !state.hatchCompleted else { return }
                            let json = String(line.dropFirst("HATCH_PROGRESS:".count))
                            if let data = json.data(using: .utf8),
                               let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                               let step = parsed["step"] as? Int,
                               let total = parsed["total"] as? Int,
                               let label = parsed["label"] as? String,
                               total > 0, step >= 0, step <= total {
                                state.hatchCurrentStep = step
                                state.hatchTotalSteps = total
                                state.hatchStepLabel = label
                                state.hatchProgressTarget = min(Double(step) / Double(total), 0.95)
                            }
                            return  // Don't append sentinel lines to hatchLogLines
                        }

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
