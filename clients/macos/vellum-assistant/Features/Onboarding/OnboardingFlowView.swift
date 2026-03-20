import SwiftUI
import VellumAssistantShared
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "OnboardingFlowView")

@MainActor
struct OnboardingFlowView: View {
    @Bindable var state: OnboardingState
    let daemonClient: DaemonClientProtocol
    @Bindable var authManager: AuthManager
    let managedBootstrapEnabled: Bool
    var onComplete: () -> Void
    var onOpenSettings: () -> Void

    @State private var isAdvancingFromWakeUp = false
    @State private var isBootstrappingManaged = false
    @State private var isResolvingAssociatedManagedAssistant = false
    @State private var managedBootstrapError: String?

    private static let appIcon: NSImage? = {
        guard let path = ResourceBundle.bundle.path(forResource: "vellum-app-icon", ofType: "png") else { return nil }
        return NSImage(contentsOfFile: path)
    }()

    private var managedSignInEnabled: Bool {
        MacOSClientFeatureFlagManager.shared.isEnabled("managed_sign_in_enabled")
    }

    private var maxOnboardingStep: Int {
        return 3
    }

    var body: some View {
        GeometryReader { geometry in
        ZStack {
            VColor.surfaceOverlay.ignoresSafeArea()

            if state.isHatching {
                HatchingStepView(state: state)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(
                        RadialGradient(
                            colors: [
                                VColor.surfaceOverlay,
                                VColor.surfaceOverlay
                            ],
                            center: .center,
                            startRadius: 0,
                            endRadius: 500
                        )
                        .ignoresSafeArea()
                    )
            } else if (0...maxOnboardingStep).contains(state.currentStep) {
                // Onboarding flow: WakeUp → HostingSelector → APIKeyEntry → ImproveExperience (steps 0–3)
                ScrollView(.vertical, showsIndicators: false) {
                VStack(spacing: 0) {
                    // Fixed top inset — positions the icon consistently
                    // across all steps regardless of bottom content weight.
                    Color.clear.frame(height: VSpacing.xxxl)

                    if let nsImage = Self.appIcon {
                        Image(nsImage: nsImage)
                            .resizable()
                            .aspectRatio(contentMode: .fit)
                            .frame(width: 96, height: 96)
                            .clipShape(RoundedRectangle(cornerRadius: VRadius.xl))
                            .padding(.bottom, VSpacing.xl)
                    }

                    // Step content — Group flattens into parent VStack so
                    // the inner Spacer flexes with the top Spacer above.
                    Group {
                        if isBootstrappingManaged {
                            managedBootstrapView
                        } else {
                            switch state.currentStep {
                            case 0:
                                if managedSignInEnabled && authManager.isAuthenticated {
                                    // Already authenticated — show a brief loading
                                    // state while the .task advances to Setup.
                                    HStack(spacing: VSpacing.sm) {
                                        ProgressView()
                                            .controlSize(.small)
                                            .progressViewStyle(.circular)
                                    }

                                    Spacer()
                                } else {
                                    WakeUpStepView(
                                        state: state,
                                        authManager: managedSignInEnabled ? authManager : nil,
                                        isAdvancing: isAdvancingFromWakeUp,
                                        managedSignInEnabled: managedSignInEnabled,
                                        onStartWithAPIKey: {
                                            guard !isAdvancingFromWakeUp else { return }
                                            isAdvancingFromWakeUp = true
                                            state.hasHatched = true
                                            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                                                state.advance()
                                            }
                                        },
                                        onContinueWithVellum: {
                                            Task {
                                                await continueWithManagedAssistant()
                                            }
                                        }
                                    )
                                }
                            case 1:
                                APIKeyStepView(
                                    state: state,
                                    isAuthenticated: authManager.isAuthenticated,
                                    onHatchManaged: {
                                        Task {
                                            await performManagedBootstrap()
                                        }
                                    }
                                )
                            case 2:
                                APIKeyEntryStepView(state: state)
                            case 3:
                                ImproveExperienceStepView(state: state, skippedAPIKeyEntry: state.skippedAPIKeyEntry)
                            default:
                                EmptyView()
                            }
                        }
                    }
                    .transition(
                        .asymmetric(
                            insertion: .opacity.combined(with: .offset(y: 12)),
                            removal: .opacity.combined(with: .offset(y: -8))
                        )
                    )
                    .id(isBootstrappingManaged ? -1 : state.currentStep)

                    // Bottom padding so content isn't flush with window edge.
                    // Skip for steps with characters footer (0, 2) where the
                    // graphic is designed to sit flush at the window bottom.
                    if (state.currentStep != 0 && state.currentStep != 2) || isBootstrappingManaged {
                        Color.clear.frame(height: VSpacing.xxl)
                    }
                }
                .frame(maxWidth: .infinity, minHeight: geometry.size.height, alignment: .top)
                }
                .scrollBounceBehavior(.basedOnSize)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(
                    RadialGradient(
                        colors: [
                            VColor.surfaceBase,
                            VColor.surfaceOverlay
                        ],
                        center: .center,
                        startRadius: 0,
                        endRadius: 500
                    )
                    .ignoresSafeArea()
                )
            }
        }
        }
        .task {
            if !authManager.isAuthenticated {
                await authManager.checkSession()
            }
            if managedSignInEnabled && authManager.isAuthenticated && state.currentStep == 0 {
                await continueManagedOnboardingAfterAuthentication()
            }
        }
        .onChange(of: state.currentStep) { _, newStep in
            if newStep == 0 {
                isAdvancingFromWakeUp = false
                if managedSignInEnabled && authManager.isAuthenticated {
                    Task {
                        await continueManagedOnboardingAfterAuthentication()
                    }
                }
            }
            if newStep > maxOnboardingStep {
                onComplete()
            }
        }
        .onChange(of: authManager.isAuthenticated) { _, isAuthenticated in
            let currentAssistant = LockfileAssistant.loadLatest()
            log.info(
                "Observed auth state change in onboarding: isAuthenticated=\(isAuthenticated, privacy: .public) managedBootstrapEnabled=\(self.managedBootstrapEnabled, privacy: .public) lockfileAssistantId=\(currentAssistant?.assistantId ?? "<none>", privacy: .public)"
            )
            if !isAuthenticated && managedSignInEnabled && state.currentStep > 0 {
                log.info("User signed out during managed onboarding — returning to welcome screen")
                isBootstrappingManaged = false
                managedBootstrapError = nil
                withAnimation(.spring(duration: 0.6, bounce: 0.15)) {
                    state.currentStep = 0
                }
                return
            }
            if isAuthenticated {
                if let assistant = currentAssistant {
                    if assistant.isManaged && managedSignInEnabled && state.currentStep == 0 {
                        log.info("Authenticated with managed assistant \(assistant.assistantId, privacy: .public); advancing to hosting selector")
                        state.advance()
                    } else if assistant.isManaged {
                        log.info("Authenticated with managed assistant \(assistant.assistantId, privacy: .public); starting managed bootstrap")
                        Task {
                            await performManagedBootstrap()
                        }
                    } else if !assistant.isRemote {
                        log.info("Auth completed for local assistant \(assistant.assistantId, privacy: .public) — deferring local registration until app startup")
                        onComplete()
                    } else {
                        log.info("Auth completed for remote assistant \(assistant.assistantId, privacy: .public) — proceeding to app")
                        onComplete()
                    }
                } else if managedBootstrapEnabled {
                    if managedSignInEnabled && state.currentStep == 0 {
                        Task {
                            await continueManagedOnboardingAfterAuthentication()
                        }
                    } else {
                        log.info("Session restored with no lockfile assistant — staying on welcome screen for user-initiated hatch")
                    }
                } else {
                    log.info("Auth completed with no lockfile assistant — proceeding to app")
                    onComplete()
                }
            }
        }
        .onChange(of: state.hatchCompleted) { _, completed in
            if completed {
                onComplete()
            }
        }
    }

    // MARK: - Managed Bootstrap

    private func continueWithManagedAssistant() async {
        switch onboardingManagedContinuationAction(isAuthenticated: authManager.isAuthenticated) {
        case .startLogin:
            await authManager.startWorkOSLogin()
        case .bootstrap:
            state.advance()
        }
    }

    private func continueManagedOnboardingAfterAuthentication() async {
        guard managedBootstrapEnabled,
              managedSignInEnabled,
              authManager.isAuthenticated,
              state.currentStep == 0,
              !isResolvingAssociatedManagedAssistant else {
            return
        }

        isResolvingAssociatedManagedAssistant = true
        managedBootstrapError = nil
        defer { isResolvingAssociatedManagedAssistant = false }

        do {
            if let activation = try await ManagedAssistantConnectionCoordinator().activateAssociatedManagedAssistantIfPresent() {
                log.info("Authenticated with associated managed assistant \(activation.assistant.id, privacy: .public); proceeding to app")
                onComplete()
                return
            }

            log.info("Authenticated account has no associated managed assistant — advancing to hosting selector")
            state.advance()
        } catch {
            log.error("Failed to discover associated managed assistant after authentication: \(error.localizedDescription, privacy: .public)")
            state.advance()
        }
    }

    @ViewBuilder
    private var managedBootstrapView: some View {
        VStack(spacing: VSpacing.lg) {
            if managedBootstrapError == nil {
                HStack(spacing: VSpacing.sm) {
                    ProgressView()
                        .controlSize(.small)
                        .progressViewStyle(.circular)
                    Text("Setting up your assistant...")
                        .font(VFont.buttonLarge)
                        .foregroundColor(VColor.contentSecondary)
                }
            } else {
                Text("Setup failed")
                    .font(VFont.title)
                    .foregroundColor(VColor.contentDefault)

                if let error = managedBootstrapError {
                    Text(error)
                        .font(VFont.caption)
                        .foregroundColor(VColor.systemNegativeStrong)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: 280)
                }

                OnboardingButton(title: "Try again", style: .primary) {
                    Task {
                        await performManagedBootstrap()
                    }
                }
                .frame(maxWidth: 280)
            }
        }

        Spacer()
    }

    private func performManagedBootstrap() async {
        isBootstrappingManaged = true
        managedBootstrapError = nil
        state.hasExistingManagedAssistant = false
        log.info("Beginning managed assistant bootstrap")

        do {
            let activation = try await ManagedAssistantConnectionCoordinator().activateManagedAssistant()
            let assistant = activation.assistant
            state.hasExistingManagedAssistant = activation.reusedExisting

            if activation.reusedExisting {
                log.info("Managed bootstrap reused existing assistant \(assistant.id, privacy: .public)")
            } else {
                log.info("Managed bootstrap created new assistant \(assistant.id, privacy: .public)")
            }

            isBootstrappingManaged = false
            state.isManagedHatch = true
            state.isHatching = true
            log.info("Managed bootstrap completed for assistant \(assistant.id, privacy: .public); waiting for daemon connection")

            await awaitManagedAssistantReady(assistantId: assistant.id)
        } catch {
            log.error("Managed bootstrap failed: \(error.localizedDescription)")
            managedBootstrapError = error.localizedDescription
        }
    }

    /// Polls the gateway health endpoint for the managed assistant until it
    /// responds successfully or the timeout elapses.
    private func awaitManagedAssistantReady(assistantId: String) async {
        let timeout: TimeInterval = 15
        let start = CFAbsoluteTimeGetCurrent()
        var lastError: Error?
        var lastStatusCode: Int?

        while CFAbsoluteTimeGetCurrent() - start < timeout {
            do {
                let (_, response): (DaemonHealthz?, _) = try await GatewayHTTPClient.get(
                    path: "assistants/\(assistantId)/healthz",
                    timeout: 5
                ) { $0.keyDecodingStrategy = .convertFromSnakeCase }
                if response.isSuccess {
                    log.info("Managed assistant \(assistantId, privacy: .public) is ready")
                    state.hatchCompleted = true
                    return
                }
                lastStatusCode = response.statusCode
                lastError = nil
                let body = String(data: response.data, encoding: .utf8) ?? "<non-utf8>"
                log.warning("Health check returned status \(response.statusCode) for assistant \(assistantId, privacy: .public): \(body, privacy: .public)")
            } catch {
                lastError = error
                lastStatusCode = nil
                log.warning("Health check request failed for assistant \(assistantId, privacy: .public): \(error.localizedDescription, privacy: .public)")
            }

            try? await Task.sleep(nanoseconds: 2_000_000_000)
            guard !Task.isCancelled else { return }
        }

        if let error = lastError {
            log.error("Managed assistant \(assistantId, privacy: .public) not ready after \(timeout)s; last error: \(error.localizedDescription, privacy: .public)")
        } else if let statusCode = lastStatusCode {
            log.error("Managed assistant \(assistantId, privacy: .public) not ready after \(timeout)s; last status code: \(statusCode)")
        } else {
            log.error("Managed assistant \(assistantId, privacy: .public) not ready after \(timeout)s; no health check attempts completed")
        }
        state.hatchFailed = true
    }
}
